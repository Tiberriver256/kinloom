import type { PluginDatabasePort, PluginSqlStatement, PluginSqlValue } from '@kinloom/core';
import { z } from 'zod';
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
  parseRecipeCommentDbRow,
  parseRecipeItemDbRow,
  parseRecipePhotoDbRow,
  type RecipeCommentRecord,
  type RecipeCourse,
  RecipeCourseSchema,
  type RecipePhotoRecord,
  type RecipeRecord,
  redactLivingRecipeAttribution,
  slugifyRecipeTitle,
} from './schemas.js';

const CountRowSchema = z.object({ count: z.number().int().min(0) });
const SlugRowSchema = z.object({ slug: z.string().min(1) });
const IdRowSchema = z.object({ id: z.string().min(1) });
const RecipeIdRowSchema = z.object({ recipe_id: z.string().min(1) });
const MaxSortRowSchema = z.object({ max_sort: z.number().int().nullable() });
const FacetRowSchema = z.object({
  course: RecipeCourseSchema,
  tags_json: z.string(),
});
const CoverRowSchema = z.object({ cover_photo_id: z.string().nullable() });
const StarCountRowSchema = z.object({ star_count: z.number().int().min(0) });
const CommentCountRowSchema = z.object({ comment_count: z.number().int().min(0) });
const TagsArraySchema = z.array(z.string());

function escapeSqlLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const RECIPE_COLUMNS = `
  id, slug, title, summary, story_md, ingredients_json, steps_json,
  prep_minutes, cook_minutes, servings, course, tags_json,
  provenance_note, source_era, attributed_person_id, cover_photo_id,
  star_count, comment_count, version,
  created_by_id, created_by_name, updated_by_id, updated_by_name,
  created_at, updated_at, deleted_at
`.trim();

const PHOTO_COLUMNS = `
  id, recipe_id, r2_key, mime_type, size_bytes, sha256,
  width, height, orientation, caption, card_side, sort_order,
  uploaded_by_id, uploaded_by_name, created_at, deleted_at
`.trim();

const COMMENT_COLUMNS = `
  id, recipe_id, parent_comment_id, depth,
  author_id, author_key, author_name, body_md,
  created_at, edited_at, deleted_at, deleted_by_role
`.trim();

/**
 * SQL-backed RecipesRepository operating exclusively through a scoped PluginDatabasePort
 * (`plugin_recipes_*` tables only). Works identically over Cloudflare D1 and any SQLite-compatible port.
 */
export class SqlRecipesRepository implements RecipesRepository {
  readonly adapterKind: string;
  private readonly db: PluginDatabasePort;

  constructor(pluginDb: PluginDatabasePort) {
    this.db = pluginDb;
    this.adapterKind = pluginDb.adapterKind;
  }

  private async resolveUniqueSlug(title: string, explicitSlug?: string): Promise<string> {
    if (explicitSlug !== undefined) {
      const collision = await this.db.first(
        'SELECT id FROM plugin_recipes_items WHERE slug = ? AND deleted_at IS NULL LIMIT 1',
        [explicitSlug],
        (raw) => IdRowSchema.parse(raw)
      );
      if (collision) {
        throw new KinloomHttpError(
          409,
          'RECIPE_SLUG_CONFLICT',
          `Recipe slug '${explicitSlug}' is already in use.`
        );
      }
      return explicitSlug;
    }

    const base = slugifyRecipeTitle(title);
    const escapedBase = escapeSqlLikePattern(base);
    const existingRows = await this.db.query(
      "SELECT slug FROM plugin_recipes_items WHERE deleted_at IS NULL AND (slug = ? OR slug LIKE ? ESCAPE '\\')",
      [base, `${escapedBase}-%`],
      (raw) => SlugRowSchema.parse(raw).slug
    );
    const taken = new Set(existingRows);
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
    const slug = await this.resolveUniqueSlug(input.data.title, input.data.slug);
    const tags = normalizeRecipeTags(input.data.tags);
    await this.db.run(
      `INSERT INTO plugin_recipes_items (
        id, slug, title, summary, story_md, ingredients_json, steps_json,
        prep_minutes, cook_minutes, servings, course, tags_json,
        provenance_note, source_era, attributed_person_id, cover_photo_id,
        star_count, comment_count, version,
        created_by_id, created_by_name, updated_by_id, updated_by_name,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 1, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        input.id,
        slug,
        input.data.title,
        input.data.summary,
        input.data.story_md,
        JSON.stringify(input.data.ingredients),
        JSON.stringify(input.data.steps),
        input.data.prep_minutes,
        input.data.cook_minutes,
        input.data.servings,
        input.data.course,
        JSON.stringify(tags),
        input.data.provenance_note,
        input.data.source_era,
        input.data.attributed_person_id,
        input.actor.id,
        input.actor.name,
        input.actor.id,
        input.actor.name,
        input.nowIso,
        input.nowIso,
      ]
    );
    const created = await this.getRecipeById(input.id);
    if (!created) {
      throw new Error(`Failed to reload newly created recipe '${input.id}'.`);
    }
    return created;
  }

  async getRecipeById(id: string): Promise<RecipeRecord | null> {
    return this.db.first(
      `SELECT ${RECIPE_COLUMNS} FROM plugin_recipes_items WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [id],
      parseRecipeItemDbRow
    );
  }

  async getRecipeBySlug(slug: string): Promise<RecipeRecord | null> {
    return this.db.first(
      `SELECT ${RECIPE_COLUMNS} FROM plugin_recipes_items WHERE slug = ? AND deleted_at IS NULL LIMIT 1`,
      [slug],
      parseRecipeItemDbRow
    );
  }

  async getRecipeBySlugOrId(slugOrId: string): Promise<RecipeRecord | null> {
    return this.db.first(
      `SELECT ${RECIPE_COLUMNS} FROM plugin_recipes_items
       WHERE deleted_at IS NULL AND (id = ? OR slug = ?)
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END ASC
       LIMIT 1`,
      [slugOrId, slugOrId, slugOrId],
      parseRecipeItemDbRow
    );
  }

  async listRecipes(query: ListRecipesQuery = {}): Promise<ListRecipesResult> {
    const livingIds = query.exclude_living_person_ids;

    // Collect global catalog facets across active recipes.
    const facetRows = await this.db.query(
      'SELECT course, tags_json FROM plugin_recipes_items WHERE deleted_at IS NULL',
      [],
      (raw) => FacetRowSchema.parse(raw)
    );
    const courseSet = new Set<RecipeCourse>();
    const tagSet = new Set<string>();
    for (const row of facetRows) {
      courseSet.add(row.course);
      for (const tag of TagsArraySchema.parse(JSON.parse(row.tags_json))) {
        tagSet.add(tag);
      }
    }
    const facets = {
      courses: [...courseSet].sort((a, b) => a.localeCompare(b)),
      tags: [...tagSet].sort((a, b) => a.localeCompare(b)),
    };

    // Living ancestor queries must never return recipes attributed to a living person.
    if (query.attributed_person_id !== undefined && livingIds?.has(query.attributed_person_id)) {
      return { items: [], total: 0, facets };
    }

    const joins: string[] = [];
    const where: string[] = ['r.deleted_at IS NULL'];
    const params: PluginSqlValue[] = [];

    if (query.favorites_for_actor_key !== undefined) {
      joins.push('INNER JOIN plugin_recipes_stars s ON s.recipe_id = r.id');
      where.push('s.actor_key = ?');
      params.push(query.favorites_for_actor_key);
    }

    if (query.course !== undefined) {
      where.push('r.course = ?');
      params.push(query.course);
    }

    if (query.tag !== undefined && query.tag.trim().length > 0) {
      where.push('instr(r.tags_json, ?) > 0');
      params.push(JSON.stringify(query.tag.trim().toLowerCase()));
    }

    if (query.attributed_person_id !== undefined) {
      where.push('r.attributed_person_id = ?');
      params.push(query.attributed_person_id);
    }

    const searchNeedle = query.q?.trim();
    if (searchNeedle && searchNeedle.length > 0) {
      const likeArg = `%${escapeSqlLikePattern(searchNeedle.toLowerCase())}%`;
      where.push(
        "(LOWER(r.title) LIKE ? ESCAPE '\\' OR LOWER(r.summary) LIKE ? ESCAPE '\\' OR LOWER(r.provenance_note) LIKE ? ESCAPE '\\' OR LOWER(r.tags_json) LIKE ? ESCAPE '\\')"
      );
      params.push(likeArg, likeArg, likeArg, likeArg);
    }

    const sort = query.sort ?? 'newest';
    const orderBy =
      sort === 'stars' || sort === 'most_starred'
        ? 'r.star_count DESC, r.updated_at DESC, r.created_at DESC, r.id ASC'
        : sort === 'alpha'
          ? 'LOWER(r.title) ASC, r.created_at DESC, r.id ASC'
          : 'r.created_at DESC, r.id ASC';

    const joinSql = joins.length > 0 ? ` ${joins.join(' ')}` : '';
    const whereSql = where.join(' AND ');
    const { limit, offset } = clampRecipeListPagination(query.limit, query.offset);

    const rColumns = RECIPE_COLUMNS.split(',')
      .map((col) => `r.${col.trim()}`)
      .join(', ');

    let pageRows: RecipeRecord[];
    let total: number;

    if (searchNeedle && searchNeedle.length > 0) {
      // Refine tags search in JS so JSON punctuation inside tags_json never creates false hits.
      const candidates = await this.db.query(
        `SELECT ${rColumns} FROM plugin_recipes_items r${joinSql} WHERE ${whereSql} ORDER BY ${orderBy}`,
        params,
        parseRecipeItemDbRow
      );
      const matched = candidates.filter((r) => matchesRecipeSearchQuery(r, searchNeedle));
      total = matched.length;
      pageRows = matched.slice(offset, offset + limit);
    } else {
      const countRow = await this.db.first(
        `SELECT COUNT(*) AS count FROM plugin_recipes_items r${joinSql} WHERE ${whereSql}`,
        params,
        (raw) => CountRowSchema.parse(raw)
      );
      total = countRow?.count ?? 0;
      const fetched = await this.db.query(
        `SELECT ${rColumns} FROM plugin_recipes_items r${joinSql} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        parseRecipeItemDbRow
      );
      pageRows = [...fetched];
    }

    const redacted = livingIds
      ? pageRows.map((recipe) => redactLivingRecipeAttribution(recipe, livingIds))
      : pageRows;

    const viewerStarred = query.viewer_actor_key
      ? await this.getStarredRecipeIds(
          query.viewer_actor_key,
          redacted.map((r) => r.id)
        )
      : new Set<string>();

    return {
      items: redacted.map((recipe) => ({
        recipe,
        viewer_has_starred: viewerStarred.has(recipe.id),
      })),
      total,
      facets,
    };
  }

  async countActiveRecipes(): Promise<number> {
    const row = await this.db.first(
      'SELECT COUNT(*) AS count FROM plugin_recipes_items WHERE deleted_at IS NULL',
      [],
      (raw) => CountRowSchema.parse(raw)
    );
    return row?.count ?? 0;
  }

  async updateRecipe(input: UpdateRecipeRepoInput): Promise<UpdateRecipeOutcome> {
    const current = await this.getRecipeById(input.id);
    if (!current) {
      return { kind: 'not_found' };
    }
    if (current.version !== input.data.expected_version) {
      return {
        kind: 'conflict',
        expected_version: input.data.expected_version,
        server_version: current.version,
        server_recipe: current,
      };
    }

    const nextSlug = input.data.slug ?? current.slug;
    if (nextSlug !== current.slug) {
      const slugCollision = await this.db.first(
        'SELECT id FROM plugin_recipes_items WHERE slug = ? AND id != ? AND deleted_at IS NULL LIMIT 1',
        [nextSlug, input.id],
        (raw) => IdRowSchema.parse(raw)
      );
      if (slugCollision) {
        return { kind: 'slug_conflict', slug: nextSlug };
      }
    }

    const tags = normalizeRecipeTags(input.data.tags);
    const runResult = await this.db.run(
      `UPDATE plugin_recipes_items
       SET slug = ?, title = ?, summary = ?, story_md = ?,
           ingredients_json = ?, steps_json = ?,
           prep_minutes = ?, cook_minutes = ?, servings = ?, course = ?,
           tags_json = ?, provenance_note = ?, source_era = ?,
           attributed_person_id = ?,
           version = version + 1,
           updated_by_id = ?, updated_by_name = ?, updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      [
        nextSlug,
        input.data.title,
        input.data.summary,
        input.data.story_md,
        JSON.stringify(input.data.ingredients),
        JSON.stringify(input.data.steps),
        input.data.prep_minutes,
        input.data.cook_minutes,
        input.data.servings,
        input.data.course,
        JSON.stringify(tags),
        input.data.provenance_note,
        input.data.source_era,
        input.data.attributed_person_id,
        input.actor.id,
        input.actor.name,
        input.nowIso,
        input.id,
        input.data.expected_version,
      ]
    );

    const latest = await this.getRecipeById(input.id);
    if (runResult.changes === 0) {
      if (!latest) {
        return { kind: 'not_found' };
      }
      return {
        kind: 'conflict',
        expected_version: input.data.expected_version,
        server_version: latest.version,
        server_recipe: latest,
      };
    }

    if (!latest) {
      return { kind: 'not_found' };
    }
    return { kind: 'updated', recipe: latest };
  }

  async softDeleteRecipe(id: string, deletedAt: string, actor: RecipeActorIdentity): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE plugin_recipes_items
       SET deleted_at = ?, updated_at = ?, updated_by_id = ?, updated_by_name = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [deletedAt, deletedAt, actor.id, actor.name, id]
    );
    return result.changes > 0;
  }

  async addPhoto(
    input: AddRecipePhotoRepoInput
  ): Promise<{ readonly photo: RecipePhotoRecord; readonly cover_photo_id: string | null } | null> {
    const recipe = await this.getRecipeById(input.recipe_id);
    if (!recipe) {
      return null;
    }

    let sortOrder = input.sort_order;
    if (sortOrder === undefined) {
      const maxRow = await this.db.first(
        'SELECT MAX(sort_order) AS max_sort FROM plugin_recipes_photos WHERE recipe_id = ? AND deleted_at IS NULL',
        [input.recipe_id],
        (raw) => MaxSortRowSchema.parse(raw)
      );
      sortOrder = maxRow?.max_sort !== null && maxRow?.max_sort !== undefined ? maxRow.max_sort + 1 : 0;
    }

    const shouldSetCover = recipe.cover_photo_id === null || input.set_cover === true;
    const statements: PluginSqlStatement[] = [
      {
        sql: `INSERT INTO plugin_recipes_photos (
          id, recipe_id, r2_key, mime_type, size_bytes, sha256,
          width, height, orientation, caption, card_side, sort_order,
          uploaded_by_id, uploaded_by_name, created_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        params: [
          input.id,
          input.recipe_id,
          input.r2_key,
          input.mime_type,
          input.size_bytes,
          input.sha256,
          input.width,
          input.height,
          input.orientation,
          input.caption,
          input.card_side,
          sortOrder,
          input.uploaded_by.id,
          input.uploaded_by.name,
          input.nowIso,
        ],
      },
    ];

    if (shouldSetCover) {
      statements.push({
        sql: 'UPDATE plugin_recipes_items SET cover_photo_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        params: [input.id, input.nowIso, input.recipe_id],
      });
    }

    await this.db.batch(statements);
    const photo = await this.getPhotoById(input.id);
    if (!photo) {
      return null;
    }
    const nextCoverId = shouldSetCover ? photo.id : recipe.cover_photo_id;
    return { photo, cover_photo_id: nextCoverId };
  }

  async getPhotoById(photoId: string): Promise<RecipePhotoRecord | null> {
    const pColumns = PHOTO_COLUMNS.split(',')
      .map((col) => `p.${col.trim()}`)
      .join(', ');
    return this.db.first(
      `SELECT ${pColumns}
       FROM plugin_recipes_photos p
       INNER JOIN plugin_recipes_items r ON r.id = p.recipe_id
       WHERE p.id = ? AND p.deleted_at IS NULL AND r.deleted_at IS NULL
       LIMIT 1`,
      [photoId],
      parseRecipePhotoDbRow
    );
  }

  async listPhotosForRecipe(recipeId: string): Promise<readonly RecipePhotoRecord[]> {
    const pColumns = PHOTO_COLUMNS.split(',')
      .map((col) => `p.${col.trim()}`)
      .join(', ');
    return this.db.query(
      `SELECT ${pColumns}
       FROM plugin_recipes_photos p
       INNER JOIN plugin_recipes_items r ON r.id = p.recipe_id
       WHERE p.recipe_id = ? AND p.deleted_at IS NULL AND r.deleted_at IS NULL
       ORDER BY p.sort_order ASC, p.created_at ASC, p.id ASC`,
      [recipeId],
      parseRecipePhotoDbRow
    );
  }

  async updatePhoto(
    input: UpdateRecipePhotoRepoInput
  ): Promise<{ readonly photo: RecipePhotoRecord; readonly cover_photo_id: string | null } | null> {
    const recipe = await this.getRecipeById(input.recipe_id);
    if (!recipe) {
      return null;
    }
    const existing = await this.getPhotoById(input.photo_id);
    if (!existing || existing.recipe_id !== input.recipe_id) {
      return null;
    }

    const statements: PluginSqlStatement[] = [
      {
        sql: `UPDATE plugin_recipes_photos
              SET caption = ?, card_side = ?, sort_order = ?
              WHERE id = ? AND recipe_id = ? AND deleted_at IS NULL`,
        params: [
          input.caption ?? existing.caption,
          input.card_side ?? existing.card_side,
          input.sort_order ?? existing.sort_order,
          input.photo_id,
          input.recipe_id,
        ],
      },
    ];

    if (input.set_cover === true) {
      statements.push({
        sql: 'UPDATE plugin_recipes_items SET cover_photo_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        params: [input.photo_id, input.nowIso, input.recipe_id],
      });
    }

    await this.db.batch(statements);
    const updated = await this.getPhotoById(input.photo_id);
    if (!updated) {
      return null;
    }
    return {
      photo: updated,
      cover_photo_id: input.set_cover === true ? updated.id : recipe.cover_photo_id,
    };
  }

  async reorderPhotos(
    recipeId: string,
    photoIds: readonly string[],
    nowIso: string
  ): Promise<readonly RecipePhotoRecord[] | null> {
    const recipe = await this.getRecipeById(recipeId);
    if (!recipe) {
      return null;
    }
    const statements: PluginSqlStatement[] = photoIds.map((photoId, idx) => ({
      sql: 'UPDATE plugin_recipes_photos SET sort_order = ? WHERE id = ? AND recipe_id = ? AND deleted_at IS NULL',
      params: [idx, photoId, recipeId],
    }));
    statements.push({
      sql: 'UPDATE plugin_recipes_items SET updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      params: [nowIso, recipeId],
    });
    await this.db.batch(statements);
    return this.listPhotosForRecipe(recipeId);
  }

  async softDeletePhoto(
    recipeId: string,
    photoId: string,
    deletedAt: string
  ): Promise<SoftDeleteRecipePhotoResult | null> {
    const existing = await this.getPhotoById(photoId);
    if (!existing || existing.recipe_id !== recipeId) {
      return null;
    }

    await this.db.batch([
      {
        sql: 'UPDATE plugin_recipes_photos SET deleted_at = ? WHERE id = ? AND recipe_id = ? AND deleted_at IS NULL',
        params: [deletedAt, photoId, recipeId],
      },
      {
        sql: `UPDATE plugin_recipes_items
              SET cover_photo_id = (
                SELECT id FROM plugin_recipes_photos
                WHERE recipe_id = ? AND deleted_at IS NULL
                ORDER BY sort_order ASC, created_at ASC, id ASC
                LIMIT 1
              ),
              updated_at = ?
              WHERE id = ? AND cover_photo_id = ?`,
        params: [recipeId, deletedAt, recipeId, photoId],
      },
    ]);

    const coverRow = await this.db.first(
      'SELECT cover_photo_id FROM plugin_recipes_items WHERE id = ? LIMIT 1',
      [recipeId],
      (raw) => CoverRowSchema.parse(raw)
    );
    return {
      deleted: true,
      r2_key: existing.r2_key,
      cover_photo_id: coverRow?.cover_photo_id ?? null,
    };
  }

  async starRecipe(recipeId: string, actorKey: string, createdAt: string): Promise<ToggleRecipeStarOutcome> {
    const active = await this.getRecipeById(recipeId);
    if (!active) {
      return { kind: 'not_found' };
    }
    await this.db.batch([
      {
        sql: 'INSERT OR IGNORE INTO plugin_recipes_stars (recipe_id, actor_key, created_at) VALUES (?, ?, ?)',
        params: [recipeId, actorKey, createdAt],
      },
      {
        sql: 'UPDATE plugin_recipes_items SET star_count = (SELECT COUNT(*) FROM plugin_recipes_stars WHERE recipe_id = ?) WHERE id = ?',
        params: [recipeId, recipeId],
      },
    ]);
    const row = await this.db.first(
      'SELECT star_count FROM plugin_recipes_items WHERE id = ? LIMIT 1',
      [recipeId],
      (raw) => StarCountRowSchema.parse(raw)
    );
    return {
      kind: 'ok',
      recipe_id: recipeId,
      star_count: row?.star_count ?? 0,
      viewer_has_starred: true,
    };
  }

  async unstarRecipe(recipeId: string, actorKey: string): Promise<ToggleRecipeStarOutcome> {
    const active = await this.getRecipeById(recipeId);
    if (!active) {
      return { kind: 'not_found' };
    }
    await this.db.batch([
      {
        sql: 'DELETE FROM plugin_recipes_stars WHERE recipe_id = ? AND actor_key = ?',
        params: [recipeId, actorKey],
      },
      {
        sql: 'UPDATE plugin_recipes_items SET star_count = (SELECT COUNT(*) FROM plugin_recipes_stars WHERE recipe_id = ?) WHERE id = ?',
        params: [recipeId, recipeId],
      },
    ]);
    const row = await this.db.first(
      'SELECT star_count FROM plugin_recipes_items WHERE id = ? LIMIT 1',
      [recipeId],
      (raw) => StarCountRowSchema.parse(raw)
    );
    return {
      kind: 'ok',
      recipe_id: recipeId,
      star_count: row?.star_count ?? 0,
      viewer_has_starred: false,
    };
  }

  async hasActorStarred(recipeId: string, actorKey: string): Promise<boolean> {
    const row = await this.db.first(
      'SELECT recipe_id FROM plugin_recipes_stars WHERE recipe_id = ? AND actor_key = ? LIMIT 1',
      [recipeId, actorKey],
      (raw) => RecipeIdRowSchema.parse(raw)
    );
    return row !== null;
  }

  async getStarredRecipeIds(actorKey: string, recipeIds?: readonly string[]): Promise<ReadonlySet<string>> {
    if (recipeIds && recipeIds.length === 0) {
      return new Set();
    }
    if (recipeIds && recipeIds.length > 0) {
      const placeholders = recipeIds.map(() => '?').join(', ');
      const rows = await this.db.query(
        `SELECT recipe_id FROM plugin_recipes_stars WHERE actor_key = ? AND recipe_id IN (${placeholders})`,
        [actorKey, ...recipeIds],
        (raw) => RecipeIdRowSchema.parse(raw).recipe_id
      );
      return new Set(rows);
    }
    const rows = await this.db.query(
      'SELECT recipe_id FROM plugin_recipes_stars WHERE actor_key = ?',
      [actorKey],
      (raw) => RecipeIdRowSchema.parse(raw).recipe_id
    );
    return new Set(rows);
  }

  async listCommentsForRecipe(recipeId: string): Promise<readonly RecipeCommentRecord[]> {
    const recipe = await this.getRecipeById(recipeId);
    if (!recipe) {
      return [];
    }
    const cColumns = COMMENT_COLUMNS.split(',')
      .map((col) => `c.${col.trim()}`)
      .join(', ');
    return this.db.query(
      `SELECT ${cColumns}
       FROM plugin_recipes_comments c
       WHERE c.recipe_id = ?
         AND (
           c.deleted_at IS NULL
           OR (
             c.depth = 0
             AND EXISTS (
               SELECT 1 FROM plugin_recipes_comments child
               WHERE child.parent_comment_id = c.id AND child.deleted_at IS NULL
             )
           )
         )
       ORDER BY c.created_at ASC, c.id ASC`,
      [recipeId],
      parseRecipeCommentDbRow
    );
  }

  async getCommentById(recipeId: string, commentId: string): Promise<RecipeCommentRecord | null> {
    const cColumns = COMMENT_COLUMNS.split(',')
      .map((col) => `c.${col.trim()}`)
      .join(', ');
    return this.db.first(
      `SELECT ${cColumns}
       FROM plugin_recipes_comments c
       INNER JOIN plugin_recipes_items r ON r.id = c.recipe_id
       WHERE c.id = ? AND c.recipe_id = ? AND c.deleted_at IS NULL AND r.deleted_at IS NULL
       LIMIT 1`,
      [commentId, recipeId],
      parseRecipeCommentDbRow
    );
  }

  async addComment(input: AddRecipeCommentRepoInput): Promise<AddRecipeCommentOutcome> {
    const recipe = await this.getRecipeById(input.recipe_id);
    if (!recipe) {
      return { kind: 'recipe_not_found' };
    }

    let depth: 0 | 1 = 0;
    if (input.parent_comment_id !== null) {
      const parent = await this.getCommentById(input.recipe_id, input.parent_comment_id);
      if (!parent) {
        return { kind: 'parent_not_found' };
      }
      if (parent.depth >= 1) {
        return { kind: 'max_depth_exceeded' };
      }
      depth = 1;
    }

    await this.db.batch([
      {
        sql: `INSERT INTO plugin_recipes_comments (
          id, recipe_id, parent_comment_id, depth,
          author_id, author_key, author_name, body_md,
          created_at, edited_at, deleted_at, deleted_by_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        params: [
          input.id,
          input.recipe_id,
          input.parent_comment_id,
          depth,
          input.author_id,
          input.author_key,
          input.author_name,
          input.body_md,
          input.nowIso,
        ],
      },
      {
        sql: 'UPDATE plugin_recipes_items SET comment_count = (SELECT COUNT(*) FROM plugin_recipes_comments WHERE recipe_id = ? AND deleted_at IS NULL) WHERE id = ?',
        params: [input.recipe_id, input.recipe_id],
      },
    ]);

    const created = await this.getCommentById(input.recipe_id, input.id);
    const countRow = await this.db.first(
      'SELECT comment_count FROM plugin_recipes_items WHERE id = ? LIMIT 1',
      [input.recipe_id],
      (raw) => CommentCountRowSchema.parse(raw)
    );
    if (!created) {
      throw new Error(`Failed to reload created recipe comment '${input.id}'.`);
    }
    return {
      kind: 'created',
      comment: created,
      comment_count: countRow?.comment_count ?? 0,
    };
  }

  async updateComment(input: UpdateRecipeCommentRepoInput): Promise<UpdateRecipeCommentOutcome> {
    const existing = await this.getCommentById(input.recipe_id, input.comment_id);
    if (!existing) {
      return { kind: 'not_found' };
    }
    await this.db.run(
      'UPDATE plugin_recipes_comments SET body_md = ?, edited_at = ? WHERE id = ? AND recipe_id = ? AND deleted_at IS NULL',
      [input.body_md, input.edited_at, input.comment_id, input.recipe_id]
    );
    const updated = await this.getCommentById(input.recipe_id, input.comment_id);
    if (!updated) {
      return { kind: 'not_found' };
    }
    return { kind: 'updated', comment: updated };
  }

  async softDeleteComment(input: SoftDeleteRecipeCommentRepoInput): Promise<DeleteRecipeCommentOutcome> {
    const existing = await this.getCommentById(input.recipe_id, input.comment_id);
    if (!existing) {
      return { kind: 'not_found' };
    }
    await this.db.batch([
      {
        sql: 'UPDATE plugin_recipes_comments SET deleted_at = ?, deleted_by_role = ? WHERE id = ? AND recipe_id = ? AND deleted_at IS NULL',
        params: [input.deleted_at, input.deleted_by_role, input.comment_id, input.recipe_id],
      },
      {
        sql: 'UPDATE plugin_recipes_items SET comment_count = (SELECT COUNT(*) FROM plugin_recipes_comments WHERE recipe_id = ? AND deleted_at IS NULL) WHERE id = ?',
        params: [input.recipe_id, input.recipe_id],
      },
    ]);
    const countRow = await this.db.first(
      'SELECT comment_count FROM plugin_recipes_items WHERE id = ? LIMIT 1',
      [input.recipe_id],
      (raw) => CommentCountRowSchema.parse(raw)
    );
    return { kind: 'deleted', comment_count: countRow?.comment_count ?? 0 };
  }
}
