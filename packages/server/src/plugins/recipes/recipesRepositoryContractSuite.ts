import { describe, expect, it } from 'vitest';
import { KinloomHttpError } from '../../errors.js';
import type { RecipesRepository } from './recipesRepository.js';
import { CreateRecipeInputSchema, UpdateRecipeInputSchema } from './schemas.js';

export type RecipesRepositoryFactory = () => Promise<{
  readonly repo: RecipesRepository;
  readonly dispose?: () => Promise<void>;
}>;

/**
 * Shared behavioral contract test suite executed identically against
 * InMemoryRecipesRepository (@kinloom/server) and Miniflare D1 SqlRecipesRepository (@kinloom/worker).
 */
export function runRecipesRepositoryContractSuite(
  adapterName: string,
  createRepo: RecipesRepositoryFactory
): void {
  describe(`RecipesRepository Contract Suite: ${adapterName}`, () => {
    it('supports recipe CRUD, active slug collision/reuse after soft delete, and optimistic version locking', async () => {
      const { repo, dispose } = await createRepo();
      try {
        const actor = { id: 'clara@archive.example.test', name: 'Clara Alder' };
        const baseInput = CreateRecipeInputSchema.parse({
          title: 'Cardamom Farmhouse Rolls',
          summary: 'Soft yeast rolls baked for winter mornings.',
          story_md: 'Passed down on a handwritten index card.',
          ingredients: [
            { id: 'ing-1', quantity: '2', unit: 'cups', item: 'all-purpose flour' },
            { id: 'ing-2', quantity: '1', unit: 'tsp', item: 'ground cardamom', group: 'Spices' },
          ],
          steps: [
            { id: 'step-1', instruction: 'Warm the milk and bloom the yeast.' },
            { id: 'step-2', instruction: 'Knead until elastic and let rise 1 hour.' },
          ],
          prep_minutes: 30,
          cook_minutes: 20,
          servings: '12 rolls',
          course: 'bread',
          tags: ['Holiday', 'Yeast Bread', 'holiday'],
          provenance_note: 'Copied from the 1948 kitchen tin.',
          source_era: '1940s',
          attributed_person_id: 'per_ancestor_1',
        });

        const first = await repo.createRecipe({
          id: 'rec_1',
          data: baseInput,
          actor,
          nowIso: '2026-11-27T10:00:00.000Z',
        });
        expect(first.slug).toBe('cardamom-farmhouse-rolls');
        expect(first.version).toBe(1);
        expect(first.tags).toEqual(['holiday', 'yeast bread']);
        expect(await repo.countActiveRecipes()).toBe(1);

        // Auto-generated slug suffixes on collision
        const second = await repo.createRecipe({
          id: 'rec_2',
          data: { ...baseInput, slug: undefined },
          actor,
          nowIso: '2026-11-27T10:05:00.000Z',
        });
        expect(second.slug).toBe('cardamom-farmhouse-rolls-2');

        // Explicit duplicate slug fails with 409 RECIPE_SLUG_CONFLICT
        await expect(
          repo.createRecipe({
            id: 'rec_dup',
            data: { ...baseInput, slug: 'cardamom-farmhouse-rolls' },
            actor,
            nowIso: '2026-11-27T10:06:00.000Z',
          })
        ).rejects.toMatchObject({ status: 409, code: 'RECIPE_SLUG_CONFLICT' });

        // Lookup by ID, slug, or slugOrId
        expect((await repo.getRecipeById('rec_1'))?.title).toBe('Cardamom Farmhouse Rolls');
        expect((await repo.getRecipeBySlug('cardamom-farmhouse-rolls-2'))?.id).toBe('rec_2');
        expect((await repo.getRecipeBySlugOrId('cardamom-farmhouse-rolls'))?.id).toBe('rec_1');
        expect((await repo.getRecipeBySlugOrId('rec_2'))?.slug).toBe('cardamom-farmhouse-rolls-2');
        expect(await repo.getRecipeBySlugOrId('missing-id')).toBeNull();

        // Update with matching expected_version bumps version to 2
        const updateOk = await repo.updateRecipe({
          id: 'rec_1',
          data: UpdateRecipeInputSchema.parse({
            ...baseInput,
            title: 'Spiced Cardamom Farmhouse Rolls',
            expected_version: 1,
          }),
          actor: { id: 'jonah@archive.example.test', name: 'Jonah Alder' },
          nowIso: '2026-11-27T11:00:00.000Z',
        });
        expect(updateOk.kind).toBe('updated');
        if (updateOk.kind === 'updated') {
          expect(updateOk.recipe.version).toBe(2);
          expect(updateOk.recipe.title).toBe('Spiced Cardamom Farmhouse Rolls');
          expect(updateOk.recipe.updated_by_name).toBe('Jonah Alder');
        }

        // Stale version update returns structured optimistic conflict
        const conflict = await repo.updateRecipe({
          id: 'rec_1',
          data: UpdateRecipeInputSchema.parse({
            ...baseInput,
            title: 'Stale Overwrite',
            expected_version: 1,
          }),
          actor,
          nowIso: '2026-11-27T11:05:00.000Z',
        });
        expect(conflict.kind).toBe('conflict');
        if (conflict.kind === 'conflict') {
          expect(conflict.expected_version).toBe(1);
          expect(conflict.server_version).toBe(2);
          expect(conflict.server_recipe.title).toBe('Spiced Cardamom Farmhouse Rolls');
        }

        // Slug conflict on update
        const slugConflict = await repo.updateRecipe({
          id: 'rec_1',
          data: UpdateRecipeInputSchema.parse({
            ...baseInput,
            slug: 'cardamom-farmhouse-rolls-2',
            expected_version: 2,
          }),
          actor,
          nowIso: '2026-11-27T11:06:00.000Z',
        });
        expect(slugConflict).toEqual({
          kind: 'slug_conflict',
          slug: 'cardamom-farmhouse-rolls-2',
        });

        // Soft delete allows reusing the deleted recipe's slug
        expect(await repo.softDeleteRecipe('rec_1', '2026-11-27T12:00:00.000Z', actor)).toBe(true);
        expect(await repo.softDeleteRecipe('rec_1', '2026-11-27T12:01:00.000Z', actor)).toBe(false);
        expect(await repo.getRecipeById('rec_1')).toBeNull();
        expect(await repo.countActiveRecipes()).toBe(1);

        expect(
          await repo.updateRecipe({
            id: 'rec_1',
            data: UpdateRecipeInputSchema.parse({ ...baseInput, expected_version: 2 }),
            actor,
            nowIso: '2026-11-27T12:02:00.000Z',
          })
        ).toEqual({ kind: 'not_found' });

        const reused = await repo.createRecipe({
          id: 'rec_3',
          data: { ...baseInput, slug: 'cardamom-farmhouse-rolls' },
          actor,
          nowIso: '2026-11-27T12:05:00.000Z',
        });
        expect(reused.slug).toBe('cardamom-farmhouse-rolls');
        expect(await repo.countActiveRecipes()).toBe(2);
      } finally {
        await dispose?.();
      }
    });

    it('filters, searches, sorts, paginates, computes facets, and enforces living-person read redaction', async () => {
      const { repo, dispose } = await createRepo();
      try {
        const actor = { id: 'clara@archive.example.test', name: 'Clara Alder' };
        await repo.createRecipe({
          id: 'rec_a',
          data: CreateRecipeInputSchema.parse({
            title: 'Zucchini Harvest Bread',
            summary: 'Moist loaf with walnuts.',
            course: 'bread',
            tags: ['autumn', 'baking'],
            attributed_person_id: 'per_deceased_1',
          }),
          actor,
          nowIso: '2026-11-27T08:00:00.000Z',
        });
        await repo.createRecipe({
          id: 'rec_b',
          data: CreateRecipeInputSchema.parse({
            title: 'Apple Orchard Pie',
            summary: 'Crisp pastry crust.',
            course: 'dessert',
            tags: ['autumn', 'pie'],
            provenance_note: 'From the cedar cookbook.',
            attributed_person_id: 'per_reclassified_living',
          }),
          actor,
          nowIso: '2026-11-27T09:00:00.000Z',
        });
        await repo.createRecipe({
          id: 'rec_c',
          data: CreateRecipeInputSchema.parse({
            title: 'Barley Vegetable Soup',
            summary: 'Simmered in cast iron.',
            course: 'soup_salad',
            tags: ['winter'],
            attributed_person_id: 'per_deceased_1',
          }),
          actor,
          nowIso: '2026-11-27T10:00:00.000Z',
        });

        // Star rec_a twice by two actors, rec_c once
        await repo.starRecipe('rec_a', 'usr_alpha', '2026-11-27T10:10:00.000Z');
        await repo.starRecipe('rec_a', 'usr_beta', '2026-11-27T10:11:00.000Z');
        await repo.starRecipe('rec_c', 'usr_alpha', '2026-11-27T10:12:00.000Z');

        // Default sort: newest first + facets
        const newest = await repo.listRecipes({
          viewer_actor_key: 'usr_alpha',
          exclude_living_person_ids: new Set(['per_reclassified_living']),
        });
        expect(newest.total).toBe(3);
        expect(newest.items.map((i) => i.recipe.id)).toEqual(['rec_c', 'rec_b', 'rec_a']);
        expect(newest.items.map((i) => i.viewer_has_starred)).toEqual([true, false, true]);
        // Reclassified living person is redacted to null on read
        expect(newest.items[1].recipe.attributed_person_id).toBeNull();
        expect(newest.facets).toEqual({
          courses: ['bread', 'dessert', 'soup_salad'],
          tags: ['autumn', 'baking', 'pie', 'winter'],
        });

        // Querying directly by a living person ID returns empty
        const livingLookup = await repo.listRecipes({
          attributed_person_id: 'per_reclassified_living',
          exclude_living_person_ids: new Set(['per_reclassified_living']),
        });
        expect(livingLookup.items).toEqual([]);
        expect(livingLookup.total).toBe(0);

        // Sort by stars and most_starred (tie-broken by updated_at DESC)
        const byStars = await repo.listRecipes({ sort: 'stars' });
        expect(byStars.items.map((i) => i.recipe.id)).toEqual(['rec_a', 'rec_c', 'rec_b']);

        const byMostStarred = await repo.listRecipes({ sort: 'most_starred' });
        expect(byMostStarred.items.map((i) => i.recipe.id)).toEqual(['rec_a', 'rec_c', 'rec_b']);

        // Update rec_b so its updated_at is newer than rec_c, then tie their star_count at 1
        await repo.updateRecipe({
          id: 'rec_b',
          data: UpdateRecipeInputSchema.parse({
            title: 'Apple Orchard Pie',
            summary: 'Crisp pastry crust, refreshed notes.',
            course: 'dessert',
            tags: ['autumn', 'pie'],
            provenance_note: 'From the cedar cookbook.',
            attributed_person_id: 'per_reclassified_living',
            expected_version: 1,
          }),
          actor,
          nowIso: '2026-11-27T11:30:00.000Z',
        });
        await repo.starRecipe('rec_b', 'usr_beta', '2026-11-27T11:35:00.000Z');
        const byMostStarredTie = await repo.listRecipes({ sort: 'most_starred' });
        expect(byMostStarredTie.items.map((i) => i.recipe.id)).toEqual(['rec_a', 'rec_b', 'rec_c']);
        await repo.unstarRecipe('rec_b', 'usr_beta');

        // Sort alphabetically
        const byAlpha = await repo.listRecipes({ sort: 'alpha', limit: 2, offset: 1 });
        expect(byAlpha.total).toBe(3);
        expect(byAlpha.items.map((i) => i.recipe.id)).toEqual(['rec_c', 'rec_a']);

        // Filter by course, tag, ancestor, favorites, and search query
        const byCourse = await repo.listRecipes({ course: 'bread' });
        expect(byCourse.items.map((i) => i.recipe.id)).toEqual(['rec_a']);

        const byTag = await repo.listRecipes({ tag: 'autumn' });
        expect(byTag.items.map((i) => i.recipe.id)).toEqual(['rec_b', 'rec_a']);

        const byAncestor = await repo.listRecipes({ attributed_person_id: 'per_deceased_1' });
        expect(byAncestor.items.map((i) => i.recipe.id)).toEqual(['rec_c', 'rec_a']);

        const byFav = await repo.listRecipes({ favorites_for_actor_key: 'usr_beta' });
        expect(byFav.items.map((i) => i.recipe.id)).toEqual(['rec_a']);

        const bySearch = await repo.listRecipes({ q: 'cedar' });
        expect(bySearch.items.map((i) => i.recipe.id)).toEqual(['rec_b']);

        // JSON syntax characters must not match tags_json spuriously
        const byQuote = await repo.listRecipes({ q: '"' });
        expect(byQuote.items).toEqual([]);
      } finally {
        await dispose?.();
      }
    });

    it('manages ordered photos, cover reassignment on delete, and atomic reorder', async () => {
      const { repo, dispose } = await createRepo();
      try {
        const actor = { id: 'clara@archive.example.test', name: 'Clara Alder' };
        await repo.createRecipe({
          id: 'rec_photo',
          data: CreateRecipeInputSchema.parse({ title: 'Sourdough Starter Notes' }),
          actor,
          nowIso: '2026-11-27T08:00:00.000Z',
        });

        const firstPhoto = await repo.addPhoto({
          id: 'pho_1',
          recipe_id: 'rec_photo',
          r2_key: 'plugins/recipes/rec_photo/pho_1.jpg',
          mime_type: 'image/jpeg',
          size_bytes: 12345,
          sha256: '1'.repeat(64),
          width: 1200,
          height: 800,
          orientation: 1,
          caption: 'Front of card',
          card_side: 'front',
          uploaded_by: actor,
          nowIso: '2026-11-27T08:01:00.000Z',
        });
        expect(firstPhoto?.cover_photo_id).toBe('pho_1');
        expect(firstPhoto?.photo.sort_order).toBe(0);

        const secondPhoto = await repo.addPhoto({
          id: 'pho_2',
          recipe_id: 'rec_photo',
          r2_key: 'plugins/recipes/rec_photo/pho_2.png',
          mime_type: 'image/png',
          size_bytes: 23456,
          sha256: '2'.repeat(64),
          width: 1200,
          height: 800,
          orientation: 1,
          caption: 'Back of card',
          card_side: 'back',
          uploaded_by: actor,
          nowIso: '2026-11-27T08:02:00.000Z',
        });
        expect(secondPhoto?.cover_photo_id).toBe('pho_1');
        expect(secondPhoto?.photo.sort_order).toBe(1);

        // Update caption and set second photo as cover
        const updated = await repo.updatePhoto({
          recipe_id: 'rec_photo',
          photo_id: 'pho_2',
          caption: 'Back with handwritten margins',
          set_cover: true,
          nowIso: '2026-11-27T08:03:00.000Z',
        });
        expect(updated?.cover_photo_id).toBe('pho_2');
        expect(updated?.photo.caption).toBe('Back with handwritten margins');

        // Reorder puts pho_2 before pho_1
        const reordered = await repo.reorderPhotos(
          'rec_photo',
          ['pho_2', 'pho_1'],
          '2026-11-27T08:04:00.000Z'
        );
        expect(reordered?.map((p) => p.id)).toEqual(['pho_2', 'pho_1']);

        // Soft-deleting the cover photo automatically promotes the next active photo
        const deletedCover = await repo.softDeletePhoto('rec_photo', 'pho_2', '2026-11-27T08:05:00.000Z');
        expect(deletedCover).toEqual({
          deleted: true,
          r2_key: 'plugins/recipes/rec_photo/pho_2.png',
          cover_photo_id: 'pho_1',
        });
        expect(await repo.getPhotoById('pho_2')).toBeNull();

        // Soft-deleting the last photo clears cover_photo_id to null
        const deletedLast = await repo.softDeletePhoto('rec_photo', 'pho_1', '2026-11-27T08:06:00.000Z');
        expect(deletedLast?.cover_photo_id).toBeNull();
        expect(await repo.listPhotosForRecipe('rec_photo')).toEqual([]);

        // Missing recipe or photo operations return null / empty cleanly
        expect(await repo.listPhotosForRecipe('missing')).toEqual([]);
        expect(await repo.getPhotoById('missing')).toBeNull();
        expect(
          await repo.updatePhoto({
            recipe_id: 'missing',
            photo_id: 'pho_1',
            caption: 'None',
            nowIso: '2026-11-27T08:06:30.000Z',
          })
        ).toBeNull();
        expect(
          await repo.updatePhoto({
            recipe_id: 'rec_photo',
            photo_id: 'missing',
            caption: 'None',
            nowIso: '2026-11-27T08:06:30.000Z',
          })
        ).toBeNull();
        expect(await repo.reorderPhotos('missing', ['pho_1'], '2026-11-27T08:06:30.000Z')).toBeNull();
        expect(await repo.softDeletePhoto('missing', 'pho_1', '2026-11-27T08:06:30.000Z')).toBeNull();
        expect(await repo.softDeletePhoto('rec_photo', 'missing', '2026-11-27T08:06:30.000Z')).toBeNull();

        // Missing recipe returns null cleanly
        expect(
          await repo.addPhoto({
            id: 'pho_missing',
            recipe_id: 'missing',
            r2_key: 'plugins/recipes/missing/pho.jpg',
            mime_type: 'image/jpeg',
            size_bytes: 100,
            sha256: '3'.repeat(64),
            width: null,
            height: null,
            orientation: 1,
            caption: '',
            card_side: 'front',
            uploaded_by: actor,
            nowIso: '2026-11-27T08:07:00.000Z',
          })
        ).toBeNull();
      } finally {
        await dispose?.();
      }
    });

    it('keeps star/unstar strictly idempotent and enforces 2-level comments with tombstone thread integrity', async () => {
      const { repo, dispose } = await createRepo();
      try {
        const actor = { id: 'clara@archive.example.test', name: 'Clara Alder' };
        await repo.createRecipe({
          id: 'rec_social',
          data: CreateRecipeInputSchema.parse({ title: 'Oatmeal Molasses Cookies' }),
          actor,
          nowIso: '2026-11-27T08:00:00.000Z',
        });

        // Idempotent star twice
        expect(await repo.starRecipe('rec_social', 'usr_1', '2026-11-27T08:01:00.000Z')).toEqual({
          kind: 'ok',
          recipe_id: 'rec_social',
          star_count: 1,
          viewer_has_starred: true,
        });
        expect(await repo.starRecipe('rec_social', 'usr_1', '2026-11-27T08:02:00.000Z')).toEqual({
          kind: 'ok',
          recipe_id: 'rec_social',
          star_count: 1,
          viewer_has_starred: true,
        });
        expect(await repo.hasActorStarred('rec_social', 'usr_1')).toBe(true);

        // Idempotent unstar twice
        expect(await repo.unstarRecipe('rec_social', 'usr_1')).toEqual({
          kind: 'ok',
          recipe_id: 'rec_social',
          star_count: 0,
          viewer_has_starred: false,
        });
        expect(await repo.unstarRecipe('rec_social', 'usr_1')).toEqual({
          kind: 'ok',
          recipe_id: 'rec_social',
          star_count: 0,
          viewer_has_starred: false,
        });
        expect(await repo.starRecipe('missing', 'usr_1', '2026-11-27T08:03:00.000Z')).toEqual({
          kind: 'not_found',
        });
        expect(await repo.unstarRecipe('missing', 'usr_1')).toEqual({ kind: 'not_found' });

        // Top-level comment (depth 0)
        const c1 = await repo.addComment({
          id: 'cmt_1',
          recipe_id: 'rec_social',
          parent_comment_id: null,
          author_id: 'clara@archive.example.test',
          author_key: 'usr_clara',
          author_name: 'Clara Alder',
          body_md: 'Use dark molasses for best chew.',
          nowIso: '2026-11-27T09:00:00.000Z',
        });
        expect(c1.kind).toBe('created');
        if (c1.kind === 'created') {
          expect(c1.comment.depth).toBe(0);
          expect(c1.comment_count).toBe(1);
        }

        // Direct reply (depth 1)
        const c2 = await repo.addComment({
          id: 'cmt_2',
          recipe_id: 'rec_social',
          parent_comment_id: 'cmt_1',
          author_id: 'jonah@archive.example.test',
          author_key: 'usr_jonah',
          author_name: 'Jonah Alder',
          body_md: 'Confirmed, baked 11 minutes at 350F.',
          nowIso: '2026-11-27T09:05:00.000Z',
        });
        expect(c2.kind).toBe('created');
        if (c2.kind === 'created') {
          expect(c2.comment.depth).toBe(1);
          expect(c2.comment_count).toBe(2);
        }

        // Replying to a depth-1 comment is rejected with max_depth_exceeded
        const c3 = await repo.addComment({
          id: 'cmt_3',
          recipe_id: 'rec_social',
          parent_comment_id: 'cmt_2',
          author_id: 'clara@archive.example.test',
          author_key: 'usr_clara',
          author_name: 'Clara Alder',
          body_md: 'Too deep',
          nowIso: '2026-11-27T09:06:00.000Z',
        });
        expect(c3).toEqual({ kind: 'max_depth_exceeded' });

        // Missing parent or missing recipe
        expect(
          await repo.addComment({
            id: 'cmt_bad_parent',
            recipe_id: 'rec_social',
            parent_comment_id: 'nonexistent',
            author_id: 'clara@archive.example.test',
            author_key: 'usr_clara',
            author_name: 'Clara Alder',
            body_md: 'Orphan',
            nowIso: '2026-11-27T09:07:00.000Z',
          })
        ).toEqual({ kind: 'parent_not_found' });

        expect(
          await repo.addComment({
            id: 'cmt_bad_recipe',
            recipe_id: 'missing',
            parent_comment_id: null,
            author_id: 'clara@archive.example.test',
            author_key: 'usr_clara',
            author_name: 'Clara Alder',
            body_md: 'Missing recipe',
            nowIso: '2026-11-27T09:07:00.000Z',
          })
        ).toEqual({ kind: 'recipe_not_found' });

        // Edit comment
        const edited = await repo.updateComment({
          recipe_id: 'rec_social',
          comment_id: 'cmt_2',
          body_md: 'Confirmed, baked 10 minutes at 350F.',
          edited_at: '2026-11-27T09:10:00.000Z',
        });
        expect(edited.kind).toBe('updated');
        if (edited.kind === 'updated') {
          expect(edited.comment.body_md).toBe('Confirmed, baked 10 minutes at 350F.');
          expect(edited.comment.edited_at).toBe('2026-11-27T09:10:00.000Z');
        }

        // Soft-deleting root cmt_1 while active reply cmt_2 exists preserves cmt_1 as tombstone
        const delRoot = await repo.softDeleteComment({
          recipe_id: 'rec_social',
          comment_id: 'cmt_1',
          deleted_at: '2026-11-27T09:15:00.000Z',
          deleted_by_role: 'author',
        });
        expect(delRoot).toEqual({ kind: 'deleted', comment_count: 1 });

        const withTombstone = await repo.listCommentsForRecipe('rec_social');
        expect(withTombstone.map((c) => [c.id, c.deleted_at !== null, c.deleted_by_role])).toEqual([
          ['cmt_1', true, 'author'],
          ['cmt_2', false, null],
        ]);

        // Once the last active reply cmt_2 is also deleted, both cmt_1 and cmt_2 disappear completely
        const delReply = await repo.softDeleteComment({
          recipe_id: 'rec_social',
          comment_id: 'cmt_2',
          deleted_at: '2026-11-27T09:20:00.000Z',
          deleted_by_role: 'admin',
        });
        expect(delReply).toEqual({ kind: 'deleted', comment_count: 0 });
        expect(await repo.listCommentsForRecipe('rec_social')).toEqual([]);
        expect((await repo.getRecipeById('rec_social'))?.comment_count).toBe(0);

        // Missing recipe/comment edge cases
        expect(await repo.listCommentsForRecipe('missing')).toEqual([]);
        expect(await repo.getCommentById('rec_social', 'missing')).toBeNull();
        expect(
          await repo.updateComment({
            recipe_id: 'rec_social',
            comment_id: 'missing',
            body_md: 'Nope',
            edited_at: '2026-11-27T09:21:00.000Z',
          })
        ).toEqual({ kind: 'not_found' });
        expect(
          await repo.softDeleteComment({
            recipe_id: 'rec_social',
            comment_id: 'missing',
            deleted_at: '2026-11-27T09:21:00.000Z',
            deleted_by_role: 'author',
          })
        ).toEqual({ kind: 'not_found' });
        expect([...(await repo.getStarredRecipeIds('usr_1', []))]).toEqual([]);
      } finally {
        await dispose?.();
      }
    });

    it('rejects duplicate explicit slug errors as KinloomHttpError', async () => {
      const { repo, dispose } = await createRepo();
      try {
        const actor = { id: 'clara@archive.example.test', name: 'Clara Alder' };
        await repo.createRecipe({
          id: 'rec_slug_1',
          data: CreateRecipeInputSchema.parse({ title: 'Rye Loaf', slug: 'rye-loaf' }),
          actor,
          nowIso: '2026-11-27T08:00:00.000Z',
        });
        await expect(
          repo.createRecipe({
            id: 'rec_slug_2',
            data: CreateRecipeInputSchema.parse({ title: 'Rye Loaf Two', slug: 'rye-loaf' }),
            actor,
            nowIso: '2026-11-27T08:01:00.000Z',
          })
        ).rejects.toBeInstanceOf(KinloomHttpError);
      } finally {
        await dispose?.();
      }
    });
  });
}
