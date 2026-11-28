import type {
  CallerPrincipal,
  EntityReadStore,
  KinloomServerPluginContext,
  KinloomServerPluginReadonlySettingsContext,
  KinloomServerPluginStatusContext,
  PluginRouteMinRole,
  PluginSettingScalarValue,
  PluginSettingsSchema,
} from '@kinloom/core';
import { z } from 'zod';
import { randomBytes, toHex } from '../../crypto.js';
import { KinloomHttpError } from '../../errors.js';
import { decodeSegment, jsonResponse, readJsonBody } from '../../http/httpPrimitives.js';
import {
  hasSecurityEventEmitter,
  type KinloomServerPlugin,
  sanitizeMediaContentType,
} from '../../http/pluginLifecycle.js';
import type { MediaUploadRejectionInfo } from '../../services/mediaService.js';
import { extensionForImageMime, PluginMediaService } from '../../services/pluginMediaService.js';
import { KINLOOM_SERVER_VERSION } from '../../version.js';
import { InMemoryRecipesRepository } from './inMemoryRecipesRepository.js';
import { RECIPES_PLUGIN_MIGRATIONS } from './migrations.js';
import { clampRecipeListPagination, type RecipesRepository } from './recipesRepository.js';
import {
  assertDeceasedRecipeAttribution,
  CreateRecipeCommentSchema,
  CreateRecipeInputSchema,
  deriveRecipeActorKey,
  RECIPES_DATABASE_NAMESPACE,
  RECIPES_PLUGIN_ID,
  type RecipeCardSide,
  RecipeCardSideSchema,
  type RecipeCommentDeletedByRole,
  type RecipeCourse,
  RecipeCourseSchema,
  type RecipePhotoRecord,
  type RecipeRecord,
  type RecipeSortMode,
  RecipeSortModeSchema,
  redactLivingRecipeAttribution,
  toPublicRecipeComment,
  UpdateRecipeCommentSchema,
  UpdateRecipeInputSchema,
  UpdateRecipePhotoInputSchema,
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
  /** Optional minimum role for read routes. Defaults to 'archive_read' ('public' in public mode, 'viewer' in private mode). */
  readonly readMinRole?: Extract<PluginRouteMinRole, 'public' | 'archive_read' | 'viewer'>;
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

export function canCreateOrEditRecipe(principal: CallerPrincipal, settings: RecipesRuntimeSettings): boolean {
  if (principal.kind !== 'user') {
    return false;
  }
  return settings.create_edit_min_role === 'admin' ? principal.role === 'admin' : true;
}

export function canStarRecipe(principal: CallerPrincipal, settings: RecipesRuntimeSettings): boolean {
  if (principal.kind === 'user') {
    return true;
  }
  if (principal.kind === 'invite_viewer') {
    return settings.star_min_role === 'viewer';
  }
  return false;
}

export function canCommentOnRecipe(principal: CallerPrincipal, settings: RecipesRuntimeSettings): boolean {
  if (principal.kind !== 'user') {
    return false;
  }
  if (settings.comment_min_role === 'disabled') {
    return false;
  }
  return settings.comment_min_role === 'admin' ? principal.role === 'admin' : true;
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
      can_star: canStarRecipe(principal, settings),
      can_comment: false,
    };
  }

  const isAdmin = principal.role === 'admin';
  const isOwner = principal.email.trim().toLowerCase() === recipe.created_by_id.trim().toLowerCase();

  return {
    can_edit: settings.create_edit_min_role === 'admin' ? isAdmin : true,
    can_delete: isAdmin || isOwner,
    can_upload: settings.upload_min_role === 'admin' ? isAdmin : true,
    can_star: canStarRecipe(principal, settings),
    can_comment: canCommentOnRecipe(principal, settings),
  };
}

const ReorderPhotosBodySchema = z.object({
  photo_ids: z.array(z.string().trim().min(1).max(64)).min(1).max(60),
});

function parseOptionalMultipartSortOrder(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', "Field 'sort_order' must be an integer string.");
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', "Field 'sort_order' must be an integer.");
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000) {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', "Field 'sort_order' must be between 0 and 1000.");
  }
  return value;
}

function parseOptionalMultipartBoolean(raw: unknown, fieldName: string): boolean {
  if (raw === null || raw === undefined) {
    return false;
  }
  if (typeof raw !== 'string') {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Field '${fieldName}' must be 'true' or 'false'.`);
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === '' || normalized === 'false' || normalized === '0') {
    return false;
  }
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Field '${fieldName}' must be 'true' or 'false'.`);
}

function requireAuthenticatedMutationPrincipal(ctx: KinloomServerPluginContext): void {
  if (ctx.principal.kind !== 'anonymous') {
    return;
  }
  const authHeader = ctx.request.headers.get('authorization')?.trim().toLowerCase() ?? '';
  const bearerAttempted = authHeader === 'bearer' || authHeader.startsWith('bearer ');
  if (!bearerAttempted && hasSecurityEventEmitter(ctx)) {
    ctx.emitSecurityEvent({
      type: 'auth.write.forbidden',
      status: 401,
      reason: 'unauthenticated',
      requiredRole: 'editor',
      actorKind: 'anonymous',
    });
  }
  throw new KinloomHttpError(401, 'UNAUTHORIZED', 'Authentication is required.');
}

async function requireRecipeStarActorKey(
  ctx: KinloomServerPluginContext,
  settings: RecipesRuntimeSettings
): Promise<string> {
  const { principal } = ctx;
  if (principal.kind === 'invite_viewer' && settings.star_min_role !== 'viewer') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: 'invite_read_only',
        requiredRole: 'editor',
        actorKind: 'invite_viewer',
      });
    }
    throw new KinloomHttpError(403, 'FORBIDDEN', 'Sign in as a family archive member to star recipes.');
  }
  const actorKey = await deriveRecipeActorKey(principal);
  if (!actorKey) {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: 'member_required',
        requiredRole: 'editor',
        actorKind: principal.kind,
      });
    }
    throw new KinloomHttpError(403, 'FORBIDDEN', 'Only human archive members may star recipes.');
  }
  return actorKey;
}

function requireRecipeWriteActor(
  ctx: KinloomServerPluginContext,
  settings: RecipesRuntimeSettings
): { readonly id: string; readonly name: string } {
  const { principal } = ctx;
  if (principal.kind !== 'user') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: 'member_required',
        requiredRole: settings.create_edit_min_role,
        actorKind: principal.kind,
      });
    }
    throw new KinloomHttpError(
      403,
      'FORBIDDEN',
      'Only signed-in family archive members may create or edit recipes.'
    );
  }
  if (settings.create_edit_min_role === 'admin' && principal.role !== 'admin') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: 'insufficient_role',
        requiredRole: 'admin',
        actorKind: 'user',
      });
    }
    throw new KinloomHttpError(403, 'FORBIDDEN', 'Administrator role is required to create or edit recipes.');
  }
  return {
    id: principal.email,
    name: principal.display_name,
  };
}

function requireSignedInRecipeMember(
  ctx: KinloomServerPluginContext,
  message: string
): { readonly id: string; readonly name: string; readonly role: 'admin' | 'editor' } {
  const { principal } = ctx;
  if (principal.kind !== 'user') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: principal.kind === 'invite_viewer' ? 'invite_read_only' : 'member_required',
        requiredRole: 'editor',
        actorKind: principal.kind,
      });
    }
    throw new KinloomHttpError(403, 'FORBIDDEN', message);
  }
  return {
    id: principal.email,
    name: principal.display_name,
    role: principal.role,
  };
}

async function requireRecipeCommentActor(
  ctx: KinloomServerPluginContext,
  settings: RecipesRuntimeSettings
): Promise<{ readonly id: string; readonly key: string; readonly name: string }> {
  const { principal } = ctx;
  if (principal.kind !== 'user') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: principal.kind === 'invite_viewer' ? 'invite_read_only' : 'member_required',
        requiredRole: settings.comment_min_role === 'admin' ? 'admin' : 'editor',
        actorKind: principal.kind,
      });
    }
    throw new KinloomHttpError(
      403,
      'FORBIDDEN',
      'Only signed-in family archive members may post recipe comments.'
    );
  }
  if (settings.comment_min_role === 'disabled') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: 'talk_disabled',
        requiredRole: 'editor',
        actorKind: 'user',
      });
    }
    throw new KinloomHttpError(403, 'COMMENTS_DISABLED', 'Recipe comments are disabled on this archive.');
  }
  if (settings.comment_min_role === 'admin' && principal.role !== 'admin') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: 'insufficient_role',
        requiredRole: 'admin',
        actorKind: 'user',
      });
    }
    throw new KinloomHttpError(403, 'FORBIDDEN', 'Administrator role is required to post recipe comments.');
  }
  const actorKey = await deriveRecipeActorKey(principal);
  if (!actorKey) {
    throw new KinloomHttpError(
      403,
      'FORBIDDEN',
      'Only signed-in family archive members may post recipe comments.'
    );
  }
  return {
    id: principal.email,
    key: actorKey,
    name: principal.display_name,
  };
}

function assertCanEditRecipeComment(
  ctx: KinloomServerPluginContext,
  actor: { readonly id: string },
  comment: { readonly author_id: string }
): void {
  const isOwner = actor.id.trim().toLowerCase() === comment.author_id.trim().toLowerCase();
  if (isOwner) {
    return;
  }
  if (hasSecurityEventEmitter(ctx)) {
    ctx.emitSecurityEvent({
      type: 'auth.write.forbidden',
      status: 403,
      reason: 'not_owner',
      requiredRole: 'editor',
      actorKind: 'user',
    });
  }
  throw new KinloomHttpError(403, 'FORBIDDEN', 'Only the comment author may edit this comment.');
}

function resolveCommentDeleteRole(
  ctx: KinloomServerPluginContext,
  actor: { readonly id: string; readonly role: 'admin' | 'editor' },
  comment: { readonly author_id: string }
): RecipeCommentDeletedByRole {
  const isOwner = actor.id.trim().toLowerCase() === comment.author_id.trim().toLowerCase();
  if (isOwner) {
    return 'author';
  }
  if (actor.role === 'admin') {
    return 'admin';
  }
  if (hasSecurityEventEmitter(ctx)) {
    ctx.emitSecurityEvent({
      type: 'auth.write.forbidden',
      status: 403,
      reason: 'not_owner',
      requiredRole: 'admin',
      actorKind: 'user',
    });
  }
  throw new KinloomHttpError(
    403,
    'FORBIDDEN',
    'Only the comment author or an archive administrator may delete this comment.'
  );
}

function assertCanDeleteRecipe(
  ctx: KinloomServerPluginContext,
  actor: { readonly id: string; readonly role: 'admin' | 'editor' },
  recipe: Pick<RecipeRecord, 'created_by_id'>
): void {
  const isOwner = actor.id.trim().toLowerCase() === recipe.created_by_id.trim().toLowerCase();
  if (actor.role === 'admin' || isOwner) {
    return;
  }
  if (hasSecurityEventEmitter(ctx)) {
    ctx.emitSecurityEvent({
      type: 'auth.write.forbidden',
      status: 403,
      reason: 'not_owner',
      requiredRole: 'admin',
      actorKind: 'user',
    });
  }
  throw new KinloomHttpError(
    403,
    'FORBIDDEN',
    'Only the recipe creator or an archive administrator may delete this recipe.'
  );
}

function requirePhotoUploadActor(
  ctx: KinloomServerPluginContext,
  settings: RecipesRuntimeSettings
): { readonly id: string; readonly name: string } {
  const { principal } = ctx;
  if (principal.kind !== 'user') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: 'member_required',
        requiredRole: settings.upload_min_role,
        actorKind: principal.kind,
      });
    }
    throw new KinloomHttpError(
      403,
      'FORBIDDEN',
      'Only signed-in family archive members may manage recipe card photos.'
    );
  }
  if (settings.upload_min_role === 'admin' && principal.role !== 'admin') {
    if (hasSecurityEventEmitter(ctx)) {
      ctx.emitSecurityEvent({
        type: 'auth.write.forbidden',
        status: 403,
        reason: 'insufficient_role',
        requiredRole: 'admin',
        actorKind: 'user',
      });
    }
    throw new KinloomHttpError(
      403,
      'FORBIDDEN',
      'Administrator role is required to upload or modify recipe card photos.'
    );
  }
  return {
    id: principal.email,
    name: principal.display_name,
  };
}

function createRecipesMediaService(ctx: KinloomServerPluginContext): PluginMediaService {
  return new PluginMediaService({
    mediaStore: ctx.ports.mediaStore,
    namespace: RECIPES_DATABASE_NAMESPACE,
  });
}

function splitRecipesRouteSegments(pathname: string): readonly string[] {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const rest = clean === RECIPES_API_PREFIX ? '' : clean.slice(RECIPES_API_PREFIX.length + 1);
  return rest ? rest.split('/').filter(Boolean) : [];
}

function isMissingRecipesTableError(error: unknown): boolean {
  const messages: string[] = [];
  if (error instanceof Error) {
    messages.push(error.message);
    if (error.cause instanceof Error) {
      messages.push(error.cause.message);
    } else if (typeof error.cause === 'string') {
      messages.push(error.cause);
    }
  } else if (typeof error === 'string') {
    messages.push(error);
  }
  return messages.some((msg) => /no such table:\s*plugin_recipes_/i.test(msg));
}

function wrapRecipesRouteHandler(
  handler: (ctx: KinloomServerPluginContext) => Promise<Response>
): (ctx: KinloomServerPluginContext) => Promise<Response> {
  return async (ctx: KinloomServerPluginContext): Promise<Response> => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (isMissingRecipesTableError(err)) {
        throw new KinloomHttpError(
          503,
          'PLUGIN_MIGRATION_REQUIRED',
          'Family Recipe Sharing database tables (plugin_recipes_*) are missing. Apply plugin migration 0001_recipes_initial before using this endpoint.'
        );
      }
      throw err;
    }
  };
}

/**
 * Opt-in Kinloom server plugin for Family Recipe Sharing (strictly off by default).
 * Registers `/api/plugins/recipes*` read and photo endpoints, `#44` declarative admin settings,
 * and versioned `plugin_recipes_*` SQL migrations.
 */
const RECIPES_SERVER_DOCS = {
  id: 'docs-recipes-server',
  title: 'Family Recipe Sharing (Server)',
  summary:
    'SQL-backed heirloom recipe catalog with ancestor attribution, photos, stars, and threaded comments.',
  sections: [
    {
      id: 'storage-migrations',
      heading: 'Isolated Plugin SQL Namespace',
      markdown:
        'Stores recipes, photos, stars, and comments inside the isolated `plugin_recipes_*` D1 namespace via idempotent plugin migrations.',
    },
    {
      id: 'attribution-privacy',
      heading: 'Ancestor Attribution & Permissions',
      markdown:
        'Recipes can be attributed to deceased ancestors in the archive. Configure editor/viewer permissions and photo upload limits under **Plugins & Integrations**.',
    },
  ],
} as const;

export function createRecipesServerPlugin(options: RecipesServerPluginOptions = {}): KinloomServerPlugin {
  const pluginId = options.id?.trim() || RECIPES_PLUGIN_ID;

  if (options.enabled === false) {
    return {
      id: pluginId,
      name: 'Family Recipe Sharing (disabled)',
      documentation: RECIPES_SERVER_DOCS,
      version: KINLOOM_SERVER_VERSION,
      status: 'disabled',
    };
  }

  const fallbackRepo: RecipesRepository = options.repository ?? new InMemoryRecipesRepository();
  const readMinRole: Extract<PluginRouteMinRole, 'public' | 'archive_read' | 'viewer'> =
    options.readMinRole ?? 'archive_read';
  const initialSettings: RecipesRuntimeSettings = {
    ...DEFAULT_RECIPES_RUNTIME_SETTINGS,
    ...options.initialSettings,
  };
  let cachedSettings: RecipesRuntimeSettings = { ...initialSettings };

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
    try {
      const stored = await ports.pluginSettingsStore.getSettings(pluginId);
      if (!stored) {
        return cachedSettings;
      }
      return mergeRecipesSettings(initialSettings, stored.values);
    } catch {
      return cachedSettings;
    }
  }

  async function servePhotoByRecord(
    ctx: KinloomServerPluginContext,
    photo: RecipePhotoRecord
  ): Promise<Response> {
    const mediaService = createRecipesMediaService(ctx);
    const ext = extensionForImageMime(photo.mime_type);
    return mediaService.serveImageResponse({
      key: photo.r2_key,
      expectedMimeType: photo.mime_type,
      sha256: photo.sha256,
      downloadFilename: `recipe-card-${photo.id}.${ext}`,
      ifNoneMatch: ctx.request.headers.get('if-none-match'),
    });
  }

  async function handleGetRequest(ctx: KinloomServerPluginContext): Promise<Response> {
    const repo = resolveRepository(ctx);
    const segments = splitRecipesRouteSegments(ctx.url.pathname);

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

      const catalogPermissions = {
        can_create: canCreateOrEditRecipe(ctx.principal, settings),
        can_star: canStarRecipe(ctx.principal, settings),
      };

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
          permissions: catalogPermissions,
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
        permissions: catalogPermissions,
      });
    }

    // 2. GET /api/plugins/recipes/photos/:photoId
    if (segments.length === 2 && segments[0] === 'photos') {
      const photoId = decodeSegment(segments[1]).trim();
      if (!photoId) {
        throw new KinloomHttpError(404, 'PHOTO_NOT_FOUND', 'Recipe photo not found.');
      }
      const photo = await repo.getPhotoById(photoId);
      if (!photo) {
        throw new KinloomHttpError(404, 'PHOTO_NOT_FOUND', `Recipe photo '${photoId}' was not found.`);
      }
      return servePhotoByRecord(ctx, photo);
    }

    // 3. GET /api/plugins/recipes/:slugOrId/photos/:photoId
    if (segments.length === 3 && segments[1] === 'photos') {
      const slugOrId = decodeSegment(segments[0]).trim();
      const photoId = decodeSegment(segments[2]).trim();
      if (!slugOrId || !photoId) {
        throw new KinloomHttpError(404, 'PHOTO_NOT_FOUND', 'Recipe photo not found.');
      }
      const recipe = await repo.getRecipeBySlugOrId(slugOrId);
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }
      const photo = await repo.getPhotoById(photoId);
      if (!photo || photo.recipe_id !== recipe.id) {
        throw new KinloomHttpError(404, 'PHOTO_NOT_FOUND', `Recipe photo '${photoId}' was not found.`);
      }
      return servePhotoByRecord(ctx, photo);
    }

    // 4. GET /api/plugins/recipes/by-person/:personId
    if (segments.length === 2 && segments[0] === 'by-person') {
      const personId = decodeSegment(segments[1]).trim();
      if (!personId) {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Missing person ID.');
      }
      const sp = ctx.url.searchParams;
      const rawLimit = parseOptionalIntParam(sp.get('limit'), 'limit', 1, 100);
      const rawOffset = parseOptionalIntParam(sp.get('offset'), 'offset', 0, 100_000);
      const pagination = clampRecipeListPagination(rawLimit ?? 12, rawOffset);

      const [livingIds, viewerActorKey, settings] = await Promise.all([
        ctx.ports.repository.getLivingPersonIds(),
        deriveRecipeActorKey(ctx.principal),
        resolveRuntimeSettings(ctx.ports),
      ]);
      const personPermissions = { can_star: canStarRecipe(ctx.principal, settings) };

      if (livingIds.has(personId)) {
        return jsonResponse({
          person_id: personId,
          recipes: [],
          total: 0,
          permissions: personPermissions,
        });
      }

      const ancestorRefs = await resolveDeceasedAncestorRefs([personId], ctx.ports.repository, livingIds);
      const ancestorRef = ancestorRefs.get(personId) ?? null;
      if (!ancestorRef) {
        return jsonResponse({
          person_id: personId,
          recipes: [],
          total: 0,
          permissions: personPermissions,
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
        permissions: personPermissions,
      });
    }

    // 4b. GET /api/plugins/recipes/:slugOrId/comments
    if (segments.length === 2 && segments[1] === 'comments') {
      const slugOrId = decodeSegment(segments[0]).trim();
      if (!slugOrId) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', 'Recipe not found.');
      }
      const recipe = await repo.getRecipeBySlugOrId(slugOrId);
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }
      const [comments, settings] = await Promise.all([
        repo.listCommentsForRecipe(recipe.id),
        resolveRuntimeSettings(ctx.ports),
      ]);
      return jsonResponse({
        recipe_id: recipe.id,
        comments: comments.map((comment) => toPublicRecipeComment(comment, ctx.principal)),
        comment_count: recipe.comment_count,
        permissions: {
          can_comment: canCommentOnRecipe(ctx.principal, settings),
        },
      });
    }

    // 5. GET /api/plugins/recipes/:slugOrId
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
        media_limits: {
          max_photo_mb: settings.max_photo_mb,
          max_photos_per_recipe: settings.max_photos_per_recipe,
        },
      });
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
  }

  async function buildPublicRecipeDetail(
    ctx: KinloomServerPluginContext,
    repo: RecipesRepository,
    recipe: RecipeRecord
  ): Promise<PublicRecipeDetail> {
    const [livingIds, viewerActorKey] = await Promise.all([
      ctx.ports.repository.getLivingPersonIds(),
      deriveRecipeActorKey(ctx.principal),
    ]);
    const safeRecipe = redactLivingRecipeAttribution(recipe, livingIds);
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
    const viewerHasStarred = viewerActorKey ? await repo.hasActorStarred(recipe.id, viewerActorKey) : false;
    return toPublicRecipeDetail(safeRecipe, viewerHasStarred, ancestorRef);
  }

  async function handleUpdateRecipe(
    ctx: KinloomServerPluginContext,
    repo: RecipesRepository,
    slugOrId: string
  ): Promise<Response> {
    const settings = await resolveRuntimeSettings(ctx.ports);
    const actor = requireRecipeWriteActor(ctx, settings);

    const existing = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
    if (!existing) {
      throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
    }

    const parsed = UpdateRecipeInputSchema.parse(await readJsonBody(ctx.request));
    const verifiedPersonId = await assertDeceasedRecipeAttribution(
      parsed.attributed_person_id,
      ctx.ports.repository
    );

    const outcome = await repo.updateRecipe({
      id: existing.id,
      data: {
        ...parsed,
        attributed_person_id: verifiedPersonId,
      },
      actor,
      nowIso: ctx.ports.clock.nowIso(),
    });

    switch (outcome.kind) {
      case 'not_found':
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      case 'slug_conflict':
        throw new KinloomHttpError(
          409,
          'RECIPE_SLUG_CONFLICT',
          `Recipe slug '${outcome.slug}' is already in use.`
        );
      case 'conflict': {
        const publicServerRecipe = await buildPublicRecipeDetail(ctx, repo, outcome.server_recipe);
        throw new KinloomHttpError(
          409,
          'RECIPE_VERSION_CONFLICT',
          'This recipe was updated by another archive member. Reload the latest version before saving.',
          {
            expected_version: outcome.expected_version,
            server_version: outcome.server_version,
            server_updated_at: outcome.server_recipe.updated_at,
            server_updated_by_name: outcome.server_recipe.updated_by_name,
            server_recipe: publicServerRecipe,
          }
        );
      }
      case 'updated': {
        const publicRecipe = await buildPublicRecipeDetail(ctx, repo, outcome.recipe);
        const permissions = computeRecipePermissions(ctx.principal, outcome.recipe, settings);
        return jsonResponse({
          recipe: publicRecipe,
          permissions,
        });
      }
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }

  async function handlePostRequest(ctx: KinloomServerPluginContext): Promise<Response> {
    requireAuthenticatedMutationPrincipal(ctx);
    const repo = resolveRepository(ctx);
    const segments = splitRecipesRouteSegments(ctx.url.pathname);

    // POST /api/plugins/recipes/:slugOrId/comments (create top-level comment or depth-1 reply)
    if (segments.length === 2 && segments[1] === 'comments') {
      const settings = await resolveRuntimeSettings(ctx.ports);
      const actor = await requireRecipeCommentActor(ctx, settings);

      const slugOrId = decodeSegment(segments[0]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const parsed = CreateRecipeCommentSchema.parse(await readJsonBody(ctx.request));
      const commentId = `cmt_${toHex(randomBytes(8))}`;
      const outcome = await repo.addComment({
        id: commentId,
        recipe_id: recipe.id,
        parent_comment_id: parsed.parent_comment_id,
        author_id: actor.id,
        author_key: actor.key,
        author_name: actor.name,
        body_md: parsed.body_md,
        nowIso: ctx.ports.clock.nowIso(),
      });

      switch (outcome.kind) {
        case 'recipe_not_found':
          throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
        case 'parent_not_found':
          throw new KinloomHttpError(
            400,
            'INVALID_PARENT_COMMENT',
            'Parent comment does not exist on this recipe or has been removed.'
          );
        case 'max_depth_exceeded':
          throw new KinloomHttpError(
            400,
            'MAX_THREAD_DEPTH_EXCEEDED',
            'Replies cannot be nested more than one level deep.'
          );
        case 'created':
          return jsonResponse(
            {
              comment: toPublicRecipeComment(outcome.comment, ctx.principal),
              comment_count: outcome.comment_count,
            },
            201
          );
        default: {
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    }

    // POST /api/plugins/recipes/:slugOrId/star (idempotent star)
    if (segments.length === 2 && segments[1] === 'star') {
      const settings = await resolveRuntimeSettings(ctx.ports);
      const actorKey = await requireRecipeStarActorKey(ctx, settings);

      const slugOrId = decodeSegment(segments[0]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const outcome = await repo.starRecipe(recipe.id, actorKey, ctx.ports.clock.nowIso());
      if (outcome.kind === 'not_found') {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }
      return jsonResponse({
        recipe_id: outcome.recipe_id,
        star_count: outcome.star_count,
        viewer_has_starred: true,
      });
    }

    // POST /api/plugins/recipes (create structured recipe)
    if (segments.length === 0) {
      const settings = await resolveRuntimeSettings(ctx.ports);
      const actor = requireRecipeWriteActor(ctx, settings);

      const parsed = CreateRecipeInputSchema.parse(await readJsonBody(ctx.request));
      const verifiedPersonId = await assertDeceasedRecipeAttribution(
        parsed.attributed_person_id,
        ctx.ports.repository
      );

      const recipeId = `rec_${toHex(randomBytes(8))}`;
      const created = await repo.createRecipe({
        id: recipeId,
        data: {
          ...parsed,
          attributed_person_id: verifiedPersonId,
        },
        actor,
        nowIso: ctx.ports.clock.nowIso(),
      });

      const publicRecipe = await buildPublicRecipeDetail(ctx, repo, created);
      const permissions = computeRecipePermissions(ctx.principal, created, settings);
      return jsonResponse(
        {
          recipe: publicRecipe,
          permissions,
        },
        201
      );
    }

    // POST /api/plugins/recipes/:slugOrId/photos
    if (segments.length === 2 && segments[1] === 'photos') {
      const settings = await resolveRuntimeSettings(ctx.ports);
      const actor = requirePhotoUploadActor(ctx, settings);

      const slugOrId = decodeSegment(segments[0]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const existingPhotos = await repo.listPhotosForRecipe(recipe.id);
      if (existingPhotos.length >= settings.max_photos_per_recipe) {
        throw new KinloomHttpError(
          400,
          'MAX_PHOTOS_EXCEEDED',
          `This recipe already has the maximum of ${settings.max_photos_per_recipe} photos.`
        );
      }

      let formData: FormData;
      try {
        formData = await ctx.request.formData();
      } catch {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Expected multipart/form-data upload payload.');
      }

      const filePart = formData.get('file');
      if (!filePart || typeof filePart === 'string') {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Missing file field in multipart upload.');
      }

      const rawCaption = formData.get('caption');
      if (rawCaption !== null && typeof rawCaption !== 'string') {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', "Field 'caption' must be text.");
      }
      const caption = (rawCaption ?? '').trim();
      if (caption.length > 240) {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Photo caption must be 240 characters or fewer.');
      }

      const rawCardSide = formData.get('card_side');
      if (rawCardSide !== null && typeof rawCardSide !== 'string') {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', "Field 'card_side' must be text.");
      }
      let cardSide: RecipeCardSide = 'front';
      if (rawCardSide !== null && rawCardSide.trim().length > 0) {
        const parsedSide = RecipeCardSideSchema.safeParse(rawCardSide.trim());
        if (!parsedSide.success) {
          throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Invalid card_side '${rawCardSide}'.`);
        }
        cardSide = parsedSide.data;
      }

      const setCover = parseOptionalMultipartBoolean(formData.get('set_cover'), 'set_cover');
      const sortOrder = parseOptionalMultipartSortOrder(formData.get('sort_order'));

      const rawBytes = new Uint8Array(await filePart.arrayBuffer());
      const photoId = `pho_${toHex(randomBytes(8))}`;
      const mediaService = createRecipesMediaService(ctx);
      const onUploadRejected = hasSecurityEventEmitter(ctx)
        ? (info: MediaUploadRejectionInfo) => {
            ctx.emitSecurityEvent({
              type: 'media.upload.rejected',
              status: info.status,
              reason: info.reason,
              contentType: sanitizeMediaContentType(info.contentType),
              sizeBytes: info.sizeBytes,
              ...(info.maxBytes !== undefined ? { maxBytes: info.maxBytes } : {}),
            });
          }
        : undefined;

      const stored = await mediaService.storeImage({
        bytes: rawBytes,
        contentType: filePart.type,
        resourceId: recipe.id,
        assetId: photoId,
        maxBytesOverride: settings.max_photo_mb * 1024 * 1024,
        onUploadRejected,
      });

      const added = await repo.addPhoto({
        id: photoId,
        recipe_id: recipe.id,
        r2_key: stored.key,
        mime_type: stored.mimeType,
        size_bytes: stored.sizeBytes,
        sha256: stored.sha256,
        width: stored.width,
        height: stored.height,
        orientation: stored.orientation,
        caption,
        card_side: cardSide,
        sort_order: sortOrder,
        set_cover: setCover,
        uploaded_by: actor,
        nowIso: ctx.ports.clock.nowIso(),
      });

      if (!added) {
        await mediaService.deleteObject(stored.key);
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      return jsonResponse(
        {
          photo: toPublicRecipePhoto(added.photo),
          cover_photo_id: added.cover_photo_id,
          cover_photo_url: added.cover_photo_id ? buildPhotoUrl(added.cover_photo_id) : null,
        },
        201
      );
    }

    // POST /api/plugins/recipes/:slugOrId/photos/reorder
    if (segments.length === 3 && segments[1] === 'photos' && segments[2] === 'reorder') {
      const settings = await resolveRuntimeSettings(ctx.ports);
      requirePhotoUploadActor(ctx, settings);

      const slugOrId = decodeSegment(segments[0]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const parsed = ReorderPhotosBodySchema.parse(await readJsonBody(ctx.request));
      const reordered = await repo.reorderPhotos(recipe.id, parsed.photo_ids, ctx.ports.clock.nowIso());
      if (!reordered) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      return jsonResponse({
        photos: reordered.map(toPublicRecipePhoto),
      });
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route POST ${ctx.url.pathname} was not found.`);
  }

  async function handlePutRequest(ctx: KinloomServerPluginContext): Promise<Response> {
    const repo = resolveRepository(ctx);
    const segments = splitRecipesRouteSegments(ctx.url.pathname);

    // PUT /api/plugins/recipes/:slugOrId
    if (segments.length === 1) {
      const slugOrId = decodeSegment(segments[0]).trim();
      return handleUpdateRecipe(ctx, repo, slugOrId);
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route PUT ${ctx.url.pathname} was not found.`);
  }

  async function handlePatchRequest(ctx: KinloomServerPluginContext): Promise<Response> {
    const repo = resolveRepository(ctx);
    const segments = splitRecipesRouteSegments(ctx.url.pathname);

    // PATCH /api/plugins/recipes/:slugOrId
    if (segments.length === 1) {
      const slugOrId = decodeSegment(segments[0]).trim();
      return handleUpdateRecipe(ctx, repo, slugOrId);
    }

    // PATCH /api/plugins/recipes/:slugOrId/comments/:commentId (owner-only edit)
    if (segments.length === 3 && segments[1] === 'comments') {
      const actor = requireSignedInRecipeMember(
        ctx,
        'Only signed-in family archive members may edit recipe comments.'
      );

      const slugOrId = decodeSegment(segments[0]).trim();
      const commentId = decodeSegment(segments[2]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const existing = commentId ? await repo.getCommentById(recipe.id, commentId) : null;
      if (!existing) {
        throw new KinloomHttpError(404, 'COMMENT_NOT_FOUND', `Recipe comment '${commentId}' was not found.`);
      }
      assertCanEditRecipeComment(ctx, actor, existing);

      const parsed = UpdateRecipeCommentSchema.parse(await readJsonBody(ctx.request));
      const outcome = await repo.updateComment({
        recipe_id: recipe.id,
        comment_id: existing.id,
        body_md: parsed.body_md,
        edited_at: ctx.ports.clock.nowIso(),
      });
      if (outcome.kind === 'not_found') {
        throw new KinloomHttpError(404, 'COMMENT_NOT_FOUND', `Recipe comment '${commentId}' was not found.`);
      }

      return jsonResponse({
        comment: toPublicRecipeComment(outcome.comment, ctx.principal),
      });
    }

    // PATCH /api/plugins/recipes/:slugOrId/photos/:photoId
    if (segments.length === 3 && segments[1] === 'photos') {
      const settings = await resolveRuntimeSettings(ctx.ports);
      requirePhotoUploadActor(ctx, settings);

      const slugOrId = decodeSegment(segments[0]).trim();
      const photoId = decodeSegment(segments[2]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const patch = UpdateRecipePhotoInputSchema.parse(await readJsonBody(ctx.request));
      const updated = await repo.updatePhoto({
        recipe_id: recipe.id,
        photo_id: photoId,
        caption: patch.caption,
        card_side: patch.card_side,
        sort_order: patch.sort_order,
        set_cover: patch.set_cover,
        nowIso: ctx.ports.clock.nowIso(),
      });
      if (!updated) {
        throw new KinloomHttpError(404, 'PHOTO_NOT_FOUND', `Recipe photo '${photoId}' was not found.`);
      }

      return jsonResponse({
        photo: toPublicRecipePhoto(updated.photo),
        cover_photo_id: updated.cover_photo_id,
        cover_photo_url: updated.cover_photo_id ? buildPhotoUrl(updated.cover_photo_id) : null,
      });
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route PATCH ${ctx.url.pathname} was not found.`);
  }

  async function handleDeleteRequest(ctx: KinloomServerPluginContext): Promise<Response> {
    requireAuthenticatedMutationPrincipal(ctx);
    const repo = resolveRepository(ctx);
    const segments = splitRecipesRouteSegments(ctx.url.pathname);

    // DELETE /api/plugins/recipes/:slugOrId/star (idempotent unstar)
    if (segments.length === 2 && segments[1] === 'star') {
      const settings = await resolveRuntimeSettings(ctx.ports);
      const actorKey = await requireRecipeStarActorKey(ctx, settings);

      const slugOrId = decodeSegment(segments[0]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const outcome = await repo.unstarRecipe(recipe.id, actorKey);
      if (outcome.kind === 'not_found') {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }
      return jsonResponse({
        recipe_id: outcome.recipe_id,
        star_count: outcome.star_count,
        viewer_has_starred: false,
      });
    }

    // DELETE /api/plugins/recipes/:slugOrId (soft-delete by owner or admin)
    if (segments.length === 1) {
      const actor = requireSignedInRecipeMember(
        ctx,
        'Only signed-in family archive members may delete recipes.'
      );
      const slugOrId = decodeSegment(segments[0]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }
      assertCanDeleteRecipe(ctx, actor, recipe);

      const deleted = await repo.softDeleteRecipe(recipe.id, ctx.ports.clock.nowIso(), {
        id: actor.id,
        name: actor.name,
      });
      if (!deleted) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }

    // DELETE /api/plugins/recipes/:slugOrId/comments/:commentId (soft-delete by author or admin)
    if (segments.length === 3 && segments[1] === 'comments') {
      const actor = requireSignedInRecipeMember(
        ctx,
        'Only signed-in family archive members may delete recipe comments.'
      );

      const slugOrId = decodeSegment(segments[0]).trim();
      const commentId = decodeSegment(segments[2]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const existing = commentId ? await repo.getCommentById(recipe.id, commentId) : null;
      if (!existing) {
        throw new KinloomHttpError(404, 'COMMENT_NOT_FOUND', `Recipe comment '${commentId}' was not found.`);
      }
      const deletedByRole = resolveCommentDeleteRole(ctx, actor, existing);

      const outcome = await repo.softDeleteComment({
        recipe_id: recipe.id,
        comment_id: existing.id,
        deleted_at: ctx.ports.clock.nowIso(),
        deleted_by_role: deletedByRole,
      });
      if (outcome.kind === 'not_found') {
        throw new KinloomHttpError(404, 'COMMENT_NOT_FOUND', `Recipe comment '${commentId}' was not found.`);
      }

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }

    // DELETE /api/plugins/recipes/:slugOrId/photos/:photoId
    if (segments.length === 3 && segments[1] === 'photos') {
      const settings = await resolveRuntimeSettings(ctx.ports);
      requirePhotoUploadActor(ctx, settings);

      const slugOrId = decodeSegment(segments[0]).trim();
      const photoId = decodeSegment(segments[2]).trim();
      const recipe = slugOrId ? await repo.getRecipeBySlugOrId(slugOrId) : null;
      if (!recipe) {
        throw new KinloomHttpError(404, 'RECIPE_NOT_FOUND', `Recipe '${slugOrId}' was not found.`);
      }

      const deleted = await repo.softDeletePhoto(recipe.id, photoId, ctx.ports.clock.nowIso());
      if (!deleted) {
        throw new KinloomHttpError(404, 'PHOTO_NOT_FOUND', `Recipe photo '${photoId}' was not found.`);
      }

      const mediaService = createRecipesMediaService(ctx);
      await mediaService.deleteObject(deleted.r2_key);

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route DELETE ${ctx.url.pathname} was not found.`);
  }

  return {
    id: pluginId,
    name: 'Family Recipe Sharing',
    documentation: RECIPES_SERVER_DOCS,
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
        handle: wrapRecipesRouteHandler(handleGetRequest),
      },
      {
        method: 'POST',
        pathPrefix: RECIPES_API_PREFIX,
        minRole: 'public',
        handle: wrapRecipesRouteHandler(handlePostRequest),
      },
      {
        method: 'PUT',
        pathPrefix: RECIPES_API_PREFIX,
        minRole: 'editor',
        handle: wrapRecipesRouteHandler(handlePutRequest),
      },
      {
        method: 'PATCH',
        pathPrefix: RECIPES_API_PREFIX,
        minRole: 'editor',
        handle: wrapRecipesRouteHandler(handlePatchRequest),
      },
      {
        method: 'DELETE',
        pathPrefix: RECIPES_API_PREFIX,
        minRole: 'public',
        handle: wrapRecipesRouteHandler(handleDeleteRequest),
      },
    ],
    async getStatus(ctx?: KinloomServerPluginStatusContext) {
      const repo = ctx?.ports.pluginDatabaseFactory
        ? new SqlRecipesRepository(
            ctx.ports.pluginDatabaseFactory.forPlugin(pluginId, RECIPES_DATABASE_NAMESPACE)
          )
        : fallbackRepo;
      try {
        const count = await repo.countActiveRecipes();
        return {
          status: 'active' as const,
          detail: `storage=${repo.adapterKind}, recipes=${count}`,
        };
      } catch (err) {
        if (isMissingRecipesTableError(err)) {
          return {
            status: 'degraded' as const,
            detail: 'Pending plugin migration 0001_recipes_initial (plugin_recipes_* tables missing)',
          };
        }
        return {
          status: 'degraded' as const,
          detail: `storage=${repo.adapterKind} probe failed`,
        };
      }
    },
    async getReadonlySettings(
      ctx: KinloomServerPluginReadonlySettingsContext
    ): Promise<Readonly<Record<string, PluginSettingScalarValue>>> {
      const repo = ctx.ports.pluginDatabaseFactory
        ? new SqlRecipesRepository(
            ctx.ports.pluginDatabaseFactory.forPlugin(pluginId, RECIPES_DATABASE_NAMESPACE)
          )
        : fallbackRepo;
      try {
        const recipeCount = await repo.countActiveRecipes();
        return {
          storage_adapter: repo.adapterKind,
          recipe_count: recipeCount,
        };
      } catch (err) {
        if (isMissingRecipesTableError(err)) {
          return {
            storage_adapter: `${repo.adapterKind} (migration required: 0001_recipes_initial)`,
            recipe_count: 'migration required',
          };
        }
        return {
          storage_adapter: repo.adapterKind,
          recipe_count: 0,
        };
      }
    },
    onSettingsUpdated(event) {
      cachedSettings = mergeRecipesSettings(initialSettings, event.values);
    },
  };
}
