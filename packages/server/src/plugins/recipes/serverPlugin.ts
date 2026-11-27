import type {
  CallerPrincipal,
  EntityReadStore,
  KinloomServerPluginContext,
  KinloomServerPluginReadonlySettingsContext,
  PluginRouteMinRole,
  PluginSettingScalarValue,
  PluginSettingsSchema,
} from '@kinloom/core';
import { z } from 'zod';
import { KinloomHttpError } from '../../errors.js';
import { decodeSegment, jsonResponse } from '../../http/httpPrimitives.js';
import type { KinloomServerPlugin } from '../../http/pluginLifecycle.js';
import { KINLOOM_SERVER_VERSION } from '../../version.js';
import { InMemoryRecipesRepository } from './inMemoryRecipesRepository.js';
import { RECIPES_PLUGIN_MIGRATIONS } from './migrations.js';
import { clampRecipeListPagination, type RecipesRepository } from './recipesRepository.js';
import {
  deriveRecipeActorKey,
  RECIPES_DATABASE_NAMESPACE,
  RECIPES_PLUGIN_ID,
  type RecipeCourse,
  RecipeCourseSchema,
  type RecipePhotoRecord,
  type RecipeRecord,
  type RecipeSortMode,
  RecipeSortModeSchema,
  redactLivingRecipeAttribution,
} from './schemas.js';
import { SqlRecipesRepository } from './sqlRecipesRepository.js';

export const RECIPES_API_PREFIX = '/api/plugins/recipes';

export type RecipesWriteMinRoleSetting = 'editor' | 'admin';
export type RecipesStarMinRoleSetting = 'editor' | 'viewer';
export type RecipesCommentMinRoleSetting = 'editor' | 'admin' | 'disabled';

export interface RecipesRuntimeSettings {
  readonly create_edit_min_role: RecipesWriteMinRoleSetting;
  readonly upload_min_role: RecipesWriteMinRoleSetting;
  readonly star_min_role: RecipesStarMinRoleSetting;
  readonly comment_min_role: RecipesCommentMinRoleSetting;
  readonly max_photo_mb: number;
  readonly max_photos_per_recipe: number;
  readonly show_home_widget: boolean;
}

export const DEFAULT_RECIPES_RUNTIME_SETTINGS: RecipesRuntimeSettings = {
  create_edit_min_role: 'editor',
  upload_min_role: 'editor',
  star_min_role: 'editor',
  comment_min_role: 'editor',
  max_photo_mb: 10,
  max_photos_per_recipe: 12,
  show_home_widget: true,
};

export interface PublicRecipeAncestorRef {
  readonly id: string;
  readonly slug: string;
  readonly full_name: string;
}

export interface PublicRecipePhoto {
  readonly id: string;
  readonly recipe_id: string;
  readonly url: string;
  readonly mime_type: RecipePhotoRecord['mime_type'];
  readonly size_bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly orientation: number;
  readonly caption: string;
  readonly card_side: RecipePhotoRecord['card_side'];
  readonly sort_order: number;
  readonly uploaded_by_name: string;
  readonly created_at: string;
}

export interface PublicRecipeSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly prep_minutes: number | null;
  readonly cook_minutes: number | null;
  readonly servings: string;
  readonly course: RecipeCourse;
  readonly tags: readonly string[];
  readonly provenance_note: string;
  readonly source_era: string;
  readonly attributed_person_id: string | null;
  readonly attributed_person: PublicRecipeAncestorRef | null;
  readonly cover_photo_id: string | null;
  readonly cover_photo_url: string | null;
  readonly star_count: number;
  readonly comment_count: number;
  readonly viewer_has_starred: boolean;
  readonly version: number;
  readonly created_by_name: string;
  readonly updated_by_name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PublicRecipeDetail extends PublicRecipeSummary {
  readonly story_md: string;
  readonly ingredients: RecipeRecord['ingredients'];
  readonly steps: RecipeRecord['steps'];
}

export interface PublicRecipePermissions {
  readonly can_edit: boolean;
  readonly can_delete: boolean;
  readonly can_upload: boolean;
  readonly can_star: boolean;
  readonly can_comment: boolean;
}

export interface RecipesServerPluginOptions {
  /**
   * When false, returns a completely inert plugin with zero routes, zero settingsSchema,
   * zero database namespace, and zero runtime footprint. Defaults to true when invoked.
   */
  readonly enabled?: boolean;
  /** Optional custom plugin ID override. Defaults to 'kinloom-recipes'. */
  readonly id?: string;
  /**
   * Optional injected RecipesRepository (used when the host does not supply `pluginDatabaseFactory`,
   * such as hermetic tests or in-memory development servers).
   */
  readonly repository?: RecipesRepository;
  /** Optional minimum role for read routes. Defaults to 'viewer'. */
  readonly readMinRole?: Extract<PluginRouteMinRole, 'public' | 'viewer'>;
  /** Optional initial runtime settings overriding defaults before admin saves settings. */
  readonly initialSettings?: Partial<RecipesRuntimeSettings>;
}

function buildRecipesSettingsSchema(initial: RecipesRuntimeSettings): PluginSettingsSchema {
  return {
    title: 'Family Recipe Sharing',
    description:
      'Configure permissions, photo limits, and home shelf visibility for the optional Family Recipe Box plugin.',
    sections: [
      {
        id: 'runtime_status',
        title: 'Runtime Status',
        description: 'Read-only status of recipe storage and active recipe volume.',
        fields: [
          {
            key: 'storage_adapter',
            label: 'Storage Adapter',
            type: 'readonly',
            defaultValue: 'in-memory',
          },
          {
            key: 'recipe_count',
            label: 'Active Recipes',
            type: 'readonly',
            defaultValue: 0,
          },
        ],
      },
      {
        id: 'permissions',
        title: 'Permissions',
        description: 'Control which family archive roles may author recipes, upload cards, star, or comment.',
        fields: [
          {
            key: 'create_edit_min_role',
            label: 'Create & Edit Recipes',
            type: 'select',
            required: true,
            defaultValue: initial.create_edit_min_role,
            options: [
              { value: 'editor', label: 'Editors & Admins' },
              { value: 'admin', label: 'Admins only' },
            ],
          },
          {
            key: 'upload_min_role',
            label: 'Upload Recipe Card Photos',
            type: 'select',
            required: true,
            defaultValue: initial.upload_min_role,
            options: [
              { value: 'editor', label: 'Editors & Admins' },
              { value: 'admin', label: 'Admins only' },
            ],
          },
          {
            key: 'star_min_role',
            label: 'Star / Favorite Recipes',
            type: 'select',
            required: true,
            defaultValue: initial.star_min_role,
            options: [
              { value: 'editor', label: 'Signed-in members' },
              { value: 'viewer', label: 'All viewers including invite links' },
            ],
          },
          {
            key: 'comment_min_role',
            label: 'Recipe Comments',
            type: 'select',
            required: true,
            defaultValue: initial.comment_min_role,
            options: [
              { value: 'editor', label: 'Signed-in members' },
              { value: 'admin', label: 'Admins only' },
              { value: 'disabled', label: 'Comments disabled' },
            ],
          },
        ],
      },
      {
        id: 'media',
        title: 'Recipe Card Media Limits',
        description: 'Upper bounds enforced when members upload scanned recipe cards or dish photos.',
        fields: [
          {
            key: 'max_photo_mb',
            label: 'Maximum Photo Size (MB)',
            type: 'number',
            required: true,
            integer: true,
            min: 1,
            max: 25,
            defaultValue: initial.max_photo_mb,
          },
          {
            key: 'max_photos_per_recipe',
            label: 'Maximum Photos per Recipe',
            type: 'number',
            required: true,
            integer: true,
            min: 1,
            max: 30,
            defaultValue: initial.max_photos_per_recipe,
          },
        ],
      },
      {
        id: 'display',
        title: 'Display',
        description: 'Control optional Family Recipe Box integration widgets across archive pages.',
        fields: [
          {
            key: 'show_home_widget',
            label: 'Show Family Recipe Box shelf on Home page',
            type: 'boolean',
            defaultValue: initial.show_home_widget,
          },
        ],
      },
    ],
  };
}

function mergeRecipesSettings(
  base: RecipesRuntimeSettings,
  values?: Readonly<Record<string, PluginSettingScalarValue>>
): RecipesRuntimeSettings {
  if (!values) {
    return base;
  }
  const createEdit = values.create_edit_min_role;
  const uploadMin = values.upload_min_role;
  const starMin = values.star_min_role;
  const commentMin = values.comment_min_role;
  const maxPhotoMb = values.max_photo_mb;
  const maxPhotos = values.max_photos_per_recipe;
  const showHomeWidget = values.show_home_widget;

  return {
    create_edit_min_role:
      createEdit === 'editor' || createEdit === 'admin' ? createEdit : base.create_edit_min_role,
    upload_min_role: uploadMin === 'editor' || uploadMin === 'admin' ? uploadMin : base.upload_min_role,
    star_min_role: starMin === 'editor' || starMin === 'viewer' ? starMin : base.star_min_role,
    comment_min_role:
      commentMin === 'editor' || commentMin === 'admin' || commentMin === 'disabled'
        ? commentMin
        : base.comment_min_role,
    max_photo_mb:
      typeof maxPhotoMb === 'number' && Number.isInteger(maxPhotoMb) && maxPhotoMb >= 1 && maxPhotoMb <= 25
        ? maxPhotoMb
        : base.max_photo_mb,
    max_photos_per_recipe:
      typeof maxPhotos === 'number' && Number.isInteger(maxPhotos) && maxPhotos >= 1 && maxPhotos <= 30
        ? maxPhotos
        : base.max_photos_per_recipe,
    show_home_widget: typeof showHomeWidget === 'boolean' ? showHomeWidget : base.show_home_widget,
  };
}

function parseOptionalIntParam(
  raw: string | null,
  name: string,
  min: number,
  max: number
): number | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Query parameter '${name}' must be an integer.`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new KinloomHttpError(
      400,
      'VALIDATION_ERROR',
      `Query parameter '${name}' must be between ${min} and ${max}.`
    );
  }
  return value;
}

function buildPhotoUrl(photoId: string): string {
  return `${RECIPES_API_PREFIX}/photos/${encodeURIComponent(photoId)}`;
}

function toPublicRecipePhoto(photo: RecipePhotoRecord): PublicRecipePhoto {
  return {
    id: photo.id,
    recipe_id: photo.recipe_id,
    url: buildPhotoUrl(photo.id),
    mime_type: photo.mime_type,
    size_bytes: photo.size_bytes,
    width: photo.width,
    height: photo.height,
    orientation: photo.orientation,
    caption: photo.caption,
    card_side: photo.card_side,
    sort_order: photo.sort_order,
    uploaded_by_name: photo.uploaded_by_name,
    created_at: photo.created_at,
  };
}

function toPublicRecipeSummary(
  recipe: RecipeRecord,
  viewerHasStarred: boolean,
  ancestorRef: PublicRecipeAncestorRef | null
): PublicRecipeSummary {
  return {
    id: recipe.id,
    slug: recipe.slug,
    title: recipe.title,
    summary: recipe.summary,
    prep_minutes: recipe.prep_minutes,
    cook_minutes: recipe.cook_minutes,
    servings: recipe.servings,
    course: recipe.course,
    tags: recipe.tags,
    provenance_note: recipe.provenance_note,
    source_era: recipe.source_era,
    attributed_person_id: ancestorRef ? ancestorRef.id : null,
    attributed_person: ancestorRef,
    cover_photo_id: recipe.cover_photo_id,
    cover_photo_url: recipe.cover_photo_id ? buildPhotoUrl(recipe.cover_photo_id) : null,
    star_count: recipe.star_count,
    comment_count: recipe.comment_count,
    viewer_has_starred: viewerHasStarred,
    version: recipe.version,
    created_by_name: recipe.created_by_name,
    updated_by_name: recipe.updated_by_name,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
  };
}

function toPublicRecipeDetail(
  recipe: RecipeRecord,
  viewerHasStarred: boolean,
  ancestorRef: PublicRecipeAncestorRef | null
): PublicRecipeDetail {
  return {
    ...toPublicRecipeSummary(recipe, viewerHasStarred, ancestorRef),
    story_md: recipe.story_md,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
  };
}

const AncestorPersonDataSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  full_name: z.string().min(1),
  is_living: z.boolean().optional(),
});

async function resolveDeceasedAncestorRefs(
  personIds: Iterable<string>,
  entityStore: Pick<EntityReadStore, 'getEntity'>,
  livingPersonIds: ReadonlySet<string>
): Promise<Map<string, PublicRecipeAncestorRef>> {
  const uniqueIds = new Set<string>();
  for (const id of personIds) {
    if (!livingPersonIds.has(id)) {
      uniqueIds.add(id);
    }
  }
  const resolved = new Map<string, PublicRecipeAncestorRef>();
  for (const personId of uniqueIds) {
    const entity = await entityStore.getEntity('person', personId);
    if (
      !entity ||
      entity.deleted_at !== null ||
      !('entity_type' in entity) ||
      entity.entity_type !== 'person'
    ) {
      continue;
    }
    const parsed = AncestorPersonDataSchema.safeParse(entity.data);
    if (!parsed.success) {
      continue;
    }
    const person = parsed.data;
    if (person.is_living === true || person.full_name === 'Living') {
      continue;
    }
    resolved.set(personId, {
      id: person.id,
      slug: person.slug,
      full_name: person.full_name,
    });
  }
  return resolved;
}

export function computeRecipePermissions(
  principal: CallerPrincipal,
  recipe: Pick<RecipeRecord, 'created_by_id'>,
  settings: RecipesRuntimeSettings
): PublicRecipePermissions {
  if (principal.kind === 'anonymous' || principal.kind === 'agent') {
    return {
      can_edit: false,
      can_delete: false,
      can_upload: false,
      can_star: false,
      can_comment: false,
    };
  }
  if (principal.kind === 'invite_viewer') {
    return {
      can_edit: false,
      can_delete: false,
      can_upload: false,
      can_star: settings.star_min_role === 'viewer',
      can_comment: false,
    };
  }

  const isAdmin = principal.role === 'admin';
  const isOwner = principal.email.trim().toLowerCase() === recipe.created_by_id.trim().toLowerCase();

  return {
    can_edit: settings.create_edit_min_role === 'admin' ? isAdmin : true,
    can_delete: isAdmin || isOwner,
    can_upload: settings.upload_min_role === 'admin' ? isAdmin : true,
    can_star: true,
    can_comment:
      settings.comment_min_role === 'disabled'
        ? false
        : settings.comment_min_role === 'admin'
          ? isAdmin
          : true,
  };
}

/**
 * Opt-in Kinloom server plugin for Family Recipe Sharing (strictly off by default).
 * Registers `/api/plugins/recipes*` read endpoints, `#44` declarative admin settings,
 * and versioned `plugin_recipes_*` SQL migrations.
 */
export function createRecipesServerPlugin(options: RecipesServerPluginOptions = {}): KinloomServerPlugin {
  const pluginId = options.id?.trim() || RECIPES_PLUGIN_ID;

  if (options.enabled === false) {
    return {
      id: pluginId,
      name: 'Family Recipe Sharing (disabled)',
      version: KINLOOM_SERVER_VERSION,
      status: 'disabled',
    };
  }

  const fallbackRepo: RecipesRepository = options.repository ?? new InMemoryRecipesRepository();
  const readMinRole: Extract<PluginRouteMinRole, 'public' | 'viewer'> = options.readMinRole ?? 'viewer';
  let cachedSettings: RecipesRuntimeSettings = {
    ...DEFAULT_RECIPES_RUNTIME_SETTINGS,
    ...options.initialSettings,
  };

  function resolveRepository(ctx: Pick<KinloomServerPluginContext, 'pluginDb'>): RecipesRepository {
    if (ctx.pluginDb) {
      return new SqlRecipesRepository(ctx.pluginDb);
    }
    return fallbackRepo;
  }

  async function resolveRuntimeSettings(
    ports: KinloomServerPluginContext['ports']
  ): Promise<RecipesRuntimeSettings> {
    if (!ports.pluginSettingsStore) {
      return cachedSettings;
    }
    const stored = await ports.pluginSettingsStore.getSettings(pluginId);
    if (!stored) {
      return cachedSettings;
    }
    return mergeRecipesSettings(cachedSettings, stored.values);
  }

  async function handleGetRequest(ctx: KinloomServerPluginContext): Promise<Response> {
    const repo = resolveRepository(ctx);
    const pathname = ctx.url.pathname.replace(/\/+$/, '') || '/';
    const rest = pathname === RECIPES_API_PREFIX ? '' : pathname.slice(RECIPES_API_PREFIX.length + 1);
    const segments = rest ? rest.split('/').filter(Boolean) : [];

    // 1. GET /api/plugins/recipes (catalog browse/search/filter/pagination)
    if (segments.length === 0) {
      const sp = ctx.url.searchParams;
      const rawCourse = (sp.get('course') ?? sp.get('category'))?.trim() || undefined;
      let course: RecipeCourse | undefined;
      if (rawCourse !== undefined) {
        const parsedCourse = RecipeCourseSchema.safeParse(rawCourse);
        if (!parsedCourse.success) {
          throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Invalid recipe course '${rawCourse}'.`);
        }
        course = parsedCourse.data;
      }

      const rawSort = sp.get('sort')?.trim() || undefined;
      let sort: RecipeSortMode | undefined;
      if (rawSort !== undefined) {
        const parsedSort = RecipeSortModeSchema.safeParse(rawSort);
        if (!parsedSort.success) {
          throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Invalid recipe sort '${rawSort}'.`);
        }
        sort = parsedSort.data;
      }

      const rawLimit = parseOptionalIntParam(sp.get('limit'), 'limit', 1, 100);
      const rawOffset = parseOptionalIntParam(sp.get('offset'), 'offset', 0, 100_000);
      const pagination = clampRecipeListPagination(rawLimit, rawOffset);

      const q = sp.get('q')?.trim() || undefined;
      const tag = sp.get('tag')?.trim().toLowerCase() || undefined;
      const attributedPersonId = sp.get('attributed_person_id')?.trim() || undefined;
      const favoritesRequested = sp.get('favorites') === '1' || sp.get('favorites') === 'true';

      const [livingIds, viewerActorKey, settings] = await Promise.all([
        ctx.ports.repository.getLivingPersonIds(),
        deriveRecipeActorKey(ctx.principal),
        resolveRuntimeSettings(ctx.ports),
      ]);

      if (favoritesRequested && viewerActorKey === null) {
        const facetOnly = await repo.listRecipes({
          limit: 1,
          offset: 0,
          exclude_living_person_ids: livingIds,
        });
        return jsonResponse({
          recipes: [],
          total: 0,
          limit: pagination.limit,
          offset: pagination.offset,
          facets: facetOnly.facets,
          display: { show_home_widget: settings.show_home_widget },
        });
      }

      const result = await repo.listRecipes({
        q,
        course,
        tag,
        attributed_person_id: attributedPersonId,
        favorites_for_actor_key: favoritesRequested ? (viewerActorKey ?? undefined) : undefined,
        viewer_actor_key: viewerActorKey ?? undefined,
        sort,
        limit: pagination.limit,
        offset: pagination.offset,
        exclude_living_person_ids: livingIds,
      });

      const ancestorIds: string[] = [];
      for (const item of result.items) {
        if (item.recipe.attributed_person_id !== null) {
          ancestorIds.push(item.recipe.attributed_person_id);
        }
      }
      const ancestorRefs = await resolveDeceasedAncestorRefs(ancestorIds, ctx.ports.repository, livingIds);

      const recipes = result.items.map((item) => {
        const safeRecipe = redactLivingRecipeAttribution(item.recipe, livingIds);
        const ref =
          safeRecipe.attributed_person_id !== null
            ? (ancestorRefs.get(safeRecipe.attributed_person_id) ?? null)
            : null;
        return toPublicRecipeSummary(safeRecipe, item.viewer_has_starred, ref);
      });

      return jsonResponse({
        recipes,
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
        facets: result.facets,
        display: { show_home_widget: settings.show_home_widget },
      });
    }

    // 2. GET /api/plugins/recipes/by-person/:personId
    if (segments.length === 2 && segments[0] === 'by-person') {
      const personId = decodeSegment(segments[1]).trim();
      if (!personId) {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Missing person ID.');
      }
      const sp = ctx.url.searchParams;
      const rawLimit = parseOptionalIntParam(sp.get('limit'), 'limit', 1, 100);
      const rawOffset = parseOptionalIntParam(sp.get('offset'), 'offset', 0, 100_000);
      const pagination = clampRecipeListPagination(rawLimit ?? 12, rawOffset);

      const [livingIds, viewerActorKey] = await Promise.all([
        ctx.ports.repository.getLivingPersonIds(),
        deriveRecipeActorKey(ctx.principal),
      ]);

      if (livingIds.has(personId)) {
        return jsonResponse({
          person_id: personId,
          recipes: [],
          total: 0,
        });
      }

      const ancestorRefs = await resolveDeceasedAncestorRefs([personId], ctx.ports.repository, livingIds);
      const ancestorRef = ancestorRefs.get(personId) ?? null;
      if (!ancestorRef) {
        return jsonResponse({
          person_id: personId,
          recipes: [],
          total: 0,
        });
      }

      const result = await repo.listRecipes({
        attributed_person_id: personId,
        viewer_actor_key: viewerActorKey ?? undefined,
        sort: 'stars',
        limit: pagination.limit,
        offset: pagination.offset,
        exclude_living_person_ids: livingIds,
      });

      const recipes = result.items.map((item) =>
        toPublicRecipeSummary(
          redactLivingRecipeAttribution(item.recipe, livingIds),
          item.viewer_has_starred,
          ancestorRef
        )
      );

      return jsonResponse({
        person_id: personId,
        recipes,
        total: result.total,
      });
    }

    // 3. GET /api/plugins/recipes/:slugOrId
    if (segments.length === 1) {
      const slugOrId = decodeSegment(segments[0]).trim();
      if (!slugOrId) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', 'Recipe not found.');
      }
      const found = await repo.getRecipeBySlugOrId(slugOrId);
      if (!found) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const [livingIds, viewerActorKey, photos, settings] = await Promise.all([
        ctx.ports.repository.getLivingPersonIds(),
        deriveRecipeActorKey(ctx.principal),
        repo.listPhotosForRecipe(found.id),
        resolveRuntimeSettings(ctx.ports),
      ]);

      const safeRecipe = redactLivingRecipeAttribution(found, livingIds);
      const ancestorRefs =
        safeRecipe.attributed_person_id !== null
          ? await resolveDeceasedAncestorRefs(
              [safeRecipe.attributed_person_id],
              ctx.ports.repository,
              livingIds
            )
          : new Map<string, PublicRecipeAncestorRef>();
      const ancestorRef =
        safeRecipe.attributed_person_id !== null
          ? (ancestorRefs.get(safeRecipe.attributed_person_id) ?? null)
          : null;

      const viewerHasStarred = viewerActorKey ? await repo.hasActorStarred(found.id, viewerActorKey) : false;
      const permissions = computeRecipePermissions(ctx.principal, found, settings);

      return jsonResponse({
        recipe: toPublicRecipeDetail(safeRecipe, viewerHasStarred, ancestorRef),
        photos: photos.map(toPublicRecipePhoto),
        viewer_has_starred: viewerHasStarred,
        permissions,
      });
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
  }

  return {
    id: pluginId,
    name: 'Family Recipe Sharing',
    version: KINLOOM_SERVER_VERSION,
    status: 'active',
    databaseNamespace: RECIPES_DATABASE_NAMESPACE,
    migrations: RECIPES_PLUGIN_MIGRATIONS,
    settingsSchema: buildRecipesSettingsSchema(cachedSettings),
    routes: [
      {
        method: 'GET',
        pathPrefix: RECIPES_API_PREFIX,
        minRole: readMinRole,
        handle: handleGetRequest,
      },
    ],
    async getReadonlySettings(
      ctx: KinloomServerPluginReadonlySettingsContext
    ): Promise<Readonly<Record<string, PluginSettingScalarValue>>> {
      const repo = ctx.ports.pluginDatabaseFactory
        ? new SqlRecipesRepository(
            ctx.ports.pluginDatabaseFactory.forPlugin(pluginId, RECIPES_DATABASE_NAMESPACE)
          )
        : fallbackRepo;
      let recipeCount = 0;
      try {
        recipeCount = await repo.countActiveRecipes();
      } catch {
        recipeCount = 0;
      }
      return {
        storage_adapter: repo.adapterKind,
        recipe_count: recipeCount,
      };
    },
    onSettingsUpdated(event) {
      cachedSettings = mergeRecipesSettings(cachedSettings, event.values);
    },
  };
}
