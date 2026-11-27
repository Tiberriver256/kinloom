import {
  buildRecipesListQueryString,
  filterStaticRecipes,
  parseUiRecipeDetailResponse,
  parseUiRecipeListResponse,
  parseUiRecipePhotoMutationResponse,
  parseUiRecipePhotosReorderResponse,
  parseUiRecipesByPersonResponse,
  type RecipesListQueryParams,
  type UiRecipeCardSide,
  type UiRecipeDetail,
  type UiRecipeDetailResponse,
  type UiRecipeListResponse,
  type UiRecipePhoto,
  type UiRecipePhotoMutationResponse,
  type UiRecipePhotosReorderResponse,
  type UiRecipesByPersonResponse,
} from '../lib/recipesModel.js';
import { ApiClientError } from './httpWiki/httpClient.js';
import { createHttpPluginApiClient, type PluginApiClient } from './pluginApiClient.js';

export interface UploadRecipePhotoInput {
  readonly file: File;
  readonly caption?: string;
  readonly card_side?: UiRecipeCardSide;
  readonly set_cover?: boolean;
  readonly sort_order?: number;
}

export interface UpdateRecipePhotoPatch {
  readonly caption?: string;
  readonly card_side?: UiRecipeCardSide;
  readonly sort_order?: number;
  readonly set_cover?: boolean;
}

export interface RecipesClient {
  listRecipes(
    params?: RecipesListQueryParams,
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiRecipeListResponse | null>;
  getRecipe(
    slugOrId: string,
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiRecipeDetailResponse | null>;
  listRecipesByPerson(
    personId: string,
    options?: { readonly limit?: number; readonly signal?: AbortSignal }
  ): Promise<UiRecipesByPersonResponse | null>;
  uploadRecipePhoto?(
    recipeSlugOrId: string,
    input: UploadRecipePhotoInput,
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiRecipePhotoMutationResponse>;
  updateRecipePhoto?(
    recipeSlugOrId: string,
    photoId: string,
    patch: UpdateRecipePhotoPatch,
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiRecipePhotoMutationResponse>;
  reorderRecipePhotos?(
    recipeSlugOrId: string,
    photoIds: readonly string[],
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiRecipePhotosReorderResponse>;
  deleteRecipePhoto?(
    recipeSlugOrId: string,
    photoId: string,
    options?: { readonly signal?: AbortSignal }
  ): Promise<void>;
}

export interface HttpRecipesClientOptions {
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly apiClient?: PluginApiClient;
}

/**
 * HTTP transport adapter for the opt-in Kinloom Family Recipe Sharing plugin.
 * Delegates all HTTP I/O through `PluginApiClient` so zero raw `/api/` fetches exist in UI views.
 */
export function createHttpRecipesClient(options: HttpRecipesClientOptions = {}): RecipesClient {
  const api =
    options.apiClient ??
    createHttpPluginApiClient({
      apiBaseUrl: options.apiBaseUrl,
      fetchImpl: options.fetchImpl,
    });

  return {
    async listRecipes(
      params: RecipesListQueryParams = {},
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiRecipeListResponse | null> {
      const qs = buildRecipesListQueryString(params);
      try {
        return await api.requestJson(`/api/plugins/recipes${qs}`, parseUiRecipeListResponse, {
          signal: reqOptions?.signal,
        });
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },

    async getRecipe(
      slugOrId: string,
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiRecipeDetailResponse | null> {
      try {
        return await api.requestJson(
          `/api/plugins/recipes/${encodeURIComponent(slugOrId)}`,
          parseUiRecipeDetailResponse,
          { signal: reqOptions?.signal }
        );
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },

    async listRecipesByPerson(
      personId: string,
      reqOptions?: { readonly limit?: number; readonly signal?: AbortSignal }
    ): Promise<UiRecipesByPersonResponse | null> {
      const qs =
        reqOptions?.limit !== undefined
          ? `?limit=${Math.max(1, Math.min(100, Math.trunc(reqOptions.limit)))}`
          : '';
      try {
        return await api.requestJson(
          `/api/plugins/recipes/by-person/${encodeURIComponent(personId)}${qs}`,
          parseUiRecipesByPersonResponse,
          { signal: reqOptions?.signal }
        );
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },

    async uploadRecipePhoto(
      recipeSlugOrId: string,
      input: UploadRecipePhotoInput,
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiRecipePhotoMutationResponse> {
      const formData = new FormData();
      formData.set('file', input.file, input.file.name);
      if (input.caption !== undefined && input.caption.trim().length > 0) {
        formData.set('caption', input.caption.trim());
      }
      if (input.card_side !== undefined) {
        formData.set('card_side', input.card_side);
      }
      if (input.set_cover) {
        formData.set('set_cover', 'true');
      }
      if (input.sort_order !== undefined) {
        formData.set('sort_order', String(input.sort_order));
      }
      return api.uploadMultipart(
        `/api/plugins/recipes/${encodeURIComponent(recipeSlugOrId)}/photos`,
        formData,
        parseUiRecipePhotoMutationResponse,
        reqOptions
      );
    },

    async updateRecipePhoto(
      recipeSlugOrId: string,
      photoId: string,
      patch: UpdateRecipePhotoPatch,
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiRecipePhotoMutationResponse> {
      return api.requestJson(
        `/api/plugins/recipes/${encodeURIComponent(recipeSlugOrId)}/photos/${encodeURIComponent(photoId)}`,
        parseUiRecipePhotoMutationResponse,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
          signal: reqOptions?.signal,
        }
      );
    },

    async reorderRecipePhotos(
      recipeSlugOrId: string,
      photoIds: readonly string[],
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiRecipePhotosReorderResponse> {
      return api.requestJson(
        `/api/plugins/recipes/${encodeURIComponent(recipeSlugOrId)}/photos/reorder`,
        parseUiRecipePhotosReorderResponse,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ photo_ids: photoIds }),
          signal: reqOptions?.signal,
        }
      );
    },

    async deleteRecipePhoto(
      recipeSlugOrId: string,
      photoId: string,
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<void> {
      await api.deleteNoContent(
        `/api/plugins/recipes/${encodeURIComponent(recipeSlugOrId)}/photos/${encodeURIComponent(photoId)}`,
        reqOptions
      );
    },
  };
}

export interface StaticRecipesClientOptions {
  readonly recipes: readonly UiRecipeDetail[];
  readonly photosByRecipeId?: Readonly<Record<string, readonly UiRecipePhoto[]>>;
  readonly showHomeWidget?: boolean;
}

/**
 * Pure in-memory RecipesClient for static archives, tests, and offline previews.
 */
export function createStaticRecipesClient(options: StaticRecipesClientOptions): RecipesClient {
  const showHomeWidget = options.showHomeWidget ?? true;
  const photosMap = options.photosByRecipeId ?? {};

  return {
    async listRecipes(params: RecipesListQueryParams = {}): Promise<UiRecipeListResponse> {
      return filterStaticRecipes(options.recipes, params, showHomeWidget);
    },

    async getRecipe(slugOrId: string): Promise<UiRecipeDetailResponse | null> {
      const found = options.recipes.find((r) => r.slug === slugOrId || r.id === slugOrId);
      if (!found) {
        return null;
      }
      return {
        recipe: found,
        photos: [...(photosMap[found.id] ?? [])],
        viewer_has_starred: found.viewer_has_starred,
        permissions: {
          can_edit: false,
          can_delete: false,
          can_upload: false,
          can_star: false,
          can_comment: false,
        },
      };
    },

    async listRecipesByPerson(
      personId: string,
      reqOptions?: { readonly limit?: number }
    ): Promise<UiRecipesByPersonResponse> {
      const result = filterStaticRecipes(
        options.recipes,
        {
          attributed_person_id: personId,
          sort: 'stars',
          limit: reqOptions?.limit ?? 12,
        },
        showHomeWidget
      );
      return {
        person_id: personId,
        recipes: result.recipes,
        total: result.total,
      };
    },
  };
}
