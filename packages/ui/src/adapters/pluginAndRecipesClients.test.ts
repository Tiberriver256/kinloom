import { describe, expect, it } from 'vitest';
import {
  clampLightboxPan,
  clampLightboxZoom,
  formatLightboxZoomPercent,
  stepLightboxIndex,
  stepLightboxZoom,
  validateImageUploadCandidates,
} from '../lib/lightboxModel.js';
import {
  computeOptimisticStarState,
  filterStaticRecipes,
  normalizeCatalogSortMode,
  type UiRecipeComment,
  type UiRecipeDetail,
  type UiRecipePhoto,
} from '../lib/recipesModel.js';
import { createHttpBookPublishingClient } from './bookPublishingClient.js';
import { ApiClientError } from './httpWiki/httpClient.js';
import { createHttpOpenFinanceClient } from './openFinanceClient.js';
import { createHttpPluginApiClient, resolvePluginRequestCredentials } from './pluginApiClient.js';
import { createHttpRecipesClient, createStaticRecipesClient } from './recipesClient.js';

const SAMPLE_RECIPE: UiRecipeDetail = {
  id: 'rec_1',
  slug: 'sourdough-boule',
  title: 'Sourdough Boule',
  summary: 'Crusty hearth loaf.',
  story_md: 'Passed down since 1890.',
  ingredients: [{ id: 'i1', quantity: '500', unit: 'g', item: 'flour', note: '', group: '' }],
  steps: [{ id: 's1', instruction: 'Bake in Dutch oven.', note: '' }],
  prep_minutes: 30,
  cook_minutes: 45,
  servings: '1 loaf',
  course: 'bread',
  tags: ['heirloom'],
  provenance_note: 'Grandfather bakery notebook',
  source_era: '1890s',
  attributed_person_id: 'p_ada',
  attributed_person: { id: 'p_ada', slug: 'ada-lovelace', full_name: 'Ada Lovelace' },
  cover_photo_id: null,
  cover_photo_url: null,
  star_count: 3,
  comment_count: 1,
  viewer_has_starred: true,
  version: 1,
  created_by_name: 'Clara',
  updated_by_name: 'Clara',
  created_at: '2026-11-27T08:00:00.000Z',
  updated_at: '2026-11-27T08:00:00.000Z',
};

describe('createHttpPluginApiClient', () => {
  it('resolves URLs, sends same-origin credentials, parses JSON, uploads multipart, and deletes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url.endsWith('/ok')) {
        return new Response(JSON.stringify({ value: 42 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/upload')) {
        return new Response(JSON.stringify({ uploaded: true }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/delete-ok')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/bad-json')) {
        return new Response('not-json', { status: 200 });
      }
      if (url.endsWith('/err')) {
        return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Denied' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ bad: true }), { status: 200 });
    };

    const client = createHttpPluginApiClient({ apiBaseUrl: 'https://archive.example.test/', fetchImpl });
    expect(client.resolveUrl('api/plugins/test')).toBe('https://archive.example.test/api/plugins/test');
    expect(client.resolveUrl('/api/plugins/test')).toBe('https://archive.example.test/api/plugins/test');

    const ok = await client.requestJson('/ok', (raw) => raw as { value: number });
    expect(ok).toEqual({ value: 42 });
    expect(calls[0].init?.credentials).toBe('same-origin');

    const form = new FormData();
    form.set('caption', 'Front');
    const uploaded = await client.uploadMultipart('/upload', form, (raw) => raw as { uploaded: boolean });
    expect(uploaded).toEqual({ uploaded: true });

    await expect(client.deleteNoContent('/delete-ok')).resolves.toBeUndefined();
    await expect(client.deleteNoContent('/err')).rejects.toThrow(ApiClientError);
    await expect(client.requestJson('/err', (raw) => raw)).rejects.toThrow('Denied');
    await expect(client.requestJson('/bad-json', (raw) => raw)).rejects.toThrow('Invalid JSON');
    await expect(
      client.requestJson('/invalid-shape', () => {
        throw new Error('schema mismatch');
      })
    ).rejects.toThrow('schema mismatch');
    await expect(client.uploadMultipart('/err', form, (raw) => raw)).rejects.toThrow(ApiClientError);
    await expect(client.uploadMultipart('/bad-json', form, (raw) => raw)).rejects.toThrow(
      'Invalid multipart'
    );
    await expect(
      client.uploadMultipart('/upload', form, () => {
        throw new Error('bad upload payload');
      })
    ).rejects.toThrow('bad upload payload');
  });
});

describe('createHttpRecipesClient and createStaticRecipesClient', () => {
  it('handles 200, 404 -> null, and non-404 errors across read methods', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/plugins/recipes/by-person/p_ada')) {
        return new Response(JSON.stringify({ person_id: 'p_ada', recipes: [SAMPLE_RECIPE], total: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/plugins/recipes/by-person/p_404')) {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Off' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/plugins/recipes/by-person/p_500')) {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/plugins/recipes/sourdough-boule')) {
        return new Response(
          JSON.stringify({
            recipe: SAMPLE_RECIPE,
            photos: [],
            viewer_has_starred: true,
            permissions: {
              can_edit: false,
              can_delete: false,
              can_upload: false,
              can_star: false,
              can_comment: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/plugins/recipes/missing')) {
        return new Response(JSON.stringify({ error: { code: 'RECIPE_NOT_FOUND', message: 'Missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/plugins/recipes/err')) {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Fail' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('q=404')) {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Disabled' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('q=500')) {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Server fail' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          recipes: [SAMPLE_RECIPE],
          total: 1,
          limit: 40,
          offset: 0,
          facets: { courses: ['bread'], tags: ['heirloom'] },
          display: { show_home_widget: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const client = createHttpRecipesClient({ fetchImpl });
    const list = await client.listRecipes({ sort: 'stars' });
    expect(list?.total).toBe(1);
    expect(await client.listRecipes({ q: '404' })).toBeNull();
    await expect(client.listRecipes({ q: '500' })).rejects.toThrow(ApiClientError);

    const detail = await client.getRecipe('sourdough-boule');
    expect(detail?.recipe.title).toBe('Sourdough Boule');
    expect(await client.getRecipe('missing')).toBeNull();
    await expect(client.getRecipe('err')).rejects.toThrow(ApiClientError);

    const byPerson = await client.listRecipesByPerson('p_ada', { limit: 6 });
    expect(byPerson?.total).toBe(1);
    expect(await client.listRecipesByPerson('p_404')).toBeNull();
    await expect(client.listRecipesByPerson('p_500')).rejects.toThrow(ApiClientError);
  });

  it('serves static recipes cleanly without network traffic', async () => {
    const staticClient = createStaticRecipesClient({ recipes: [SAMPLE_RECIPE] });
    const list = await staticClient.listRecipes({ course: 'bread' });
    expect(list?.total).toBe(1);
    expect((await staticClient.getRecipe('sourdough-boule'))?.recipe.id).toBe('rec_1');
    expect((await staticClient.getRecipe('rec_1'))?.recipe.slug).toBe('sourdough-boule');
    expect(await staticClient.getRecipe('nope')).toBeNull();
    expect((await staticClient.listRecipesByPerson('p_ada'))?.total).toBe(1);
  });

  it('supports photo upload, update, reorder, and delete through PluginApiClient', async () => {
    const SAMPLE_PHOTO: UiRecipePhoto = {
      id: 'pho_1',
      recipe_id: 'rec_1',
      url: '/api/plugins/recipes/photos/pho_1',
      mime_type: 'image/png',
      size_bytes: 512,
      width: 400,
      height: 300,
      orientation: 1,
      caption: 'Front of card',
      card_side: 'front',
      sort_order: 0,
      uploaded_by_name: 'Clara',
      created_at: '2026-11-27T08:00:00.000Z',
    };

    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (method === 'POST' && url.endsWith('/photos')) {
        return new Response(
          JSON.stringify({
            photo: SAMPLE_PHOTO,
            cover_photo_id: 'pho_1',
            cover_photo_url: SAMPLE_PHOTO.url,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }
      if (method === 'PATCH' && url.endsWith('/photos/pho_1')) {
        return new Response(
          JSON.stringify({
            photo: { ...SAMPLE_PHOTO, caption: 'Updated caption', card_side: 'back' },
            cover_photo_id: 'pho_1',
            cover_photo_url: SAMPLE_PHOTO.url,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (method === 'POST' && url.endsWith('/photos/reorder')) {
        return new Response(JSON.stringify({ photos: [SAMPLE_PHOTO] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'DELETE' && url.endsWith('/photos/pho_1')) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createHttpRecipesClient({ fetchImpl });
    const file = new File([new Uint8Array([1, 2, 3])], 'card.png', { type: 'image/png' });

    const uploaded = await client.uploadRecipePhoto!('sourdough-boule', {
      file,
      caption: 'Front of card',
      card_side: 'front',
      set_cover: true,
      sort_order: 0,
    });
    expect(uploaded.photo.id).toBe('pho_1');
    expect(uploaded.cover_photo_id).toBe('pho_1');

    const updated = await client.updateRecipePhoto!('sourdough-boule', 'pho_1', {
      caption: 'Updated caption',
      card_side: 'back',
      set_cover: true,
    });
    expect(updated.photo.caption).toBe('Updated caption');

    const reordered = await client.reorderRecipePhotos!('sourdough-boule', ['pho_1']);
    expect(reordered.photos).toHaveLength(1);

    await expect(client.deleteRecipePhoto!('sourdough-boule', 'pho_1')).resolves.toBeUndefined();
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/plugins/recipes/sourdough-boule/photos',
      'PATCH /api/plugins/recipes/sourdough-boule/photos/pho_1',
      'POST /api/plugins/recipes/sourdough-boule/photos/reorder',
      'DELETE /api/plugins/recipes/sourdough-boule/photos/pho_1',
    ]);
  });

  it('supports recipe create, PATCH update, and soft-delete through PluginApiClient', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({ url, method, body });
      if (method === 'POST' && url === '/api/plugins/recipes') {
        return new Response(JSON.stringify({ recipe: SAMPLE_RECIPE }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'PATCH' && url === '/api/plugins/recipes/sourdough-boule') {
        return new Response(
          JSON.stringify({ recipe: { ...SAMPLE_RECIPE, title: 'Updated Boule', version: 2 } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      if (method === 'DELETE' && url === '/api/plugins/recipes/sourdough-boule') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createHttpRecipesClient({ fetchImpl });
    const created = await client.createRecipe!({
      title: 'Sourdough Boule',
      summary: 'Crusty hearth loaf.',
      story_md: 'Passed down since 1890.',
      ingredients: SAMPLE_RECIPE.ingredients,
      steps: SAMPLE_RECIPE.steps,
      prep_minutes: 30,
      cook_minutes: 45,
      servings: '1 loaf',
      course: 'bread',
      tags: ['heirloom'],
      provenance_note: 'Grandfather bakery notebook',
      source_era: '1890s',
      attributed_person_id: 'p_ada',
    });
    expect(created.recipe.slug).toBe('sourdough-boule');

    const updated = await client.updateRecipe!('sourdough-boule', {
      title: 'Updated Boule',
      summary: 'Crusty hearth loaf.',
      story_md: 'Passed down since 1890.',
      ingredients: SAMPLE_RECIPE.ingredients,
      steps: SAMPLE_RECIPE.steps,
      prep_minutes: 30,
      cook_minutes: 45,
      servings: '1 loaf',
      course: 'bread',
      tags: ['heirloom'],
      provenance_note: 'Grandfather bakery notebook',
      source_era: '1890s',
      attributed_person_id: 'p_ada',
      expected_version: 1,
    });
    expect(updated.recipe.version).toBe(2);

    await expect(client.deleteRecipe!('sourdough-boule')).resolves.toBeUndefined();
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/plugins/recipes',
      'PATCH /api/plugins/recipes/sourdough-boule',
      'DELETE /api/plugins/recipes/sourdough-boule',
    ]);
  });

  it('supports idempotent starRecipe and unstarRecipe through PluginApiClient and pure star model helpers', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (method === 'POST' && url === '/api/plugins/recipes/sourdough-boule/star') {
        return new Response(JSON.stringify({ recipe_id: 'rec_1', star_count: 4, viewer_has_starred: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'DELETE' && url === '/api/plugins/recipes/sourdough-boule/star') {
        return new Response(
          JSON.stringify({ recipe_id: 'rec_1', star_count: 3, viewer_has_starred: false }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createHttpRecipesClient({ fetchImpl });
    expect(await client.starRecipe!('sourdough-boule')).toEqual({
      recipe_id: 'rec_1',
      star_count: 4,
      viewer_has_starred: true,
    });
    expect(await client.unstarRecipe!('sourdough-boule')).toEqual({
      recipe_id: 'rec_1',
      star_count: 3,
      viewer_has_starred: false,
    });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/plugins/recipes/sourdough-boule/star',
      'DELETE /api/plugins/recipes/sourdough-boule/star',
    ]);

    expect(computeOptimisticStarState({ star_count: 2, viewer_has_starred: false }, true)).toEqual({
      star_count: 3,
      viewer_has_starred: true,
    });
    expect(computeOptimisticStarState({ star_count: 2, viewer_has_starred: true }, true)).toEqual({
      star_count: 2,
      viewer_has_starred: true,
    });
    expect(computeOptimisticStarState({ star_count: 0, viewer_has_starred: true }, false)).toEqual({
      star_count: 0,
      viewer_has_starred: false,
    });

    expect(normalizeCatalogSortMode('most_starred')).toBe('most_starred');
    expect(normalizeCatalogSortMode('stars')).toBe('most_starred');
    expect(normalizeCatalogSortMode('newest')).toBe('newest');
    expect(normalizeCatalogSortMode('alpha')).toBe('alpha');
    expect(normalizeCatalogSortMode('unknown')).toBe('most_starred');

    const tiedA: UiRecipeDetail = {
      ...SAMPLE_RECIPE,
      id: 'rec_tie_a',
      slug: 'tie-a',
      star_count: 2,
      updated_at: '2026-11-27T09:00:00.000Z',
    };
    const tiedB: UiRecipeDetail = {
      ...SAMPLE_RECIPE,
      id: 'rec_tie_b',
      slug: 'tie-b',
      star_count: 2,
      updated_at: '2026-11-27T11:00:00.000Z',
    };
    const sorted = filterStaticRecipes([tiedA, tiedB], { sort: 'most_starred' });
    expect(sorted.recipes.map((r) => r.id)).toEqual(['rec_tie_b', 'rec_tie_a']);
  });

  it('supports recipe comments list, create, update, delete, and static comments through PluginApiClient', async () => {
    const sampleComment: UiRecipeComment = {
      id: 'cmt_1',
      parent_comment_id: null,
      depth: 0,
      deleted: false,
      deleted_by_role: null,
      author_name: 'Clara Baker',
      author_key: 'usr_clara',
      body_md: 'Bake on the center rack.',
      created_at: '2026-11-27T10:00:00.000Z',
      edited_at: null,
      can_edit: true,
      can_delete: true,
    };

    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({ url, method, body });

      if (method === 'GET' && url === '/api/plugins/recipes/sourdough-boule/comments') {
        return new Response(
          JSON.stringify({
            recipe_id: 'rec_1',
            comments: [sampleComment],
            comment_count: 1,
            permissions: { can_comment: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (method === 'GET' && url === '/api/plugins/recipes/missing/comments') {
        return new Response(JSON.stringify({ error: { code: 'RECIPE_NOT_FOUND', message: 'Missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'GET' && url === '/api/plugins/recipes/err/comments') {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && url === '/api/plugins/recipes/sourdough-boule/comments') {
        return new Response(JSON.stringify({ comment: sampleComment, comment_count: 1 }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'PATCH' && url === '/api/plugins/recipes/sourdough-boule/comments/cmt_1') {
        return new Response(
          JSON.stringify({
            comment: {
              ...sampleComment,
              body_md: 'Updated tip.',
              edited_at: '2026-11-27T10:05:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (method === 'DELETE' && url === '/api/plugins/recipes/sourdough-boule/comments/cmt_1') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createHttpRecipesClient({ fetchImpl });
    const list = await client.listRecipeComments!('sourdough-boule');
    expect(list?.comments).toHaveLength(1);
    expect(await client.listRecipeComments!('missing')).toBeNull();
    await expect(client.listRecipeComments!('err')).rejects.toThrow(ApiClientError);

    const created = await client.createRecipeComment!('sourdough-boule', {
      body_md: 'Bake on the center rack.',
    });
    expect(created.comment.id).toBe('cmt_1');

    const updated = await client.updateRecipeComment!('sourdough-boule', 'cmt_1', {
      body_md: 'Updated tip.',
    });
    expect(updated.comment.body_md).toBe('Updated tip.');
    expect(updated.comment.edited_at).toBe('2026-11-27T10:05:00.000Z');

    await expect(client.deleteRecipeComment!('sourdough-boule', 'cmt_1')).resolves.toBeUndefined();
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/plugins/recipes/sourdough-boule/comments',
      'GET /api/plugins/recipes/missing/comments',
      'GET /api/plugins/recipes/err/comments',
      'POST /api/plugins/recipes/sourdough-boule/comments',
      'PATCH /api/plugins/recipes/sourdough-boule/comments/cmt_1',
      'DELETE /api/plugins/recipes/sourdough-boule/comments/cmt_1',
    ]);

    const staticClient = createStaticRecipesClient({
      recipes: [SAMPLE_RECIPE],
      commentsByRecipeId: { rec_1: [sampleComment] },
    });
    expect((await staticClient.listRecipeComments!('sourdough-boule'))?.comment_count).toBe(1);
    expect(await staticClient.listRecipeComments!('nope')).toBeNull();
  });
});

describe('lightboxModel pure helpers', () => {
  it('clamps zoom, pan, circular indices, and validates image upload candidates', () => {
    expect(clampLightboxZoom(Number.NaN)).toBe(1);
    expect(clampLightboxZoom(0.2)).toBe(1);
    expect(clampLightboxZoom(9)).toBe(4);
    expect(stepLightboxZoom(1, 'in')).toBe(1.5);
    expect(stepLightboxZoom(1, 'out')).toBe(1);
    expect(formatLightboxZoomPercent(2.5)).toBe('250%');

    expect(clampLightboxPan({ x: 50, y: -50 }, 1)).toEqual({ x: 0, y: 0 });
    expect(clampLightboxPan({ x: 999, y: -999 }, 2, 400)).toEqual({ x: 200, y: -200 });

    expect(stepLightboxIndex(0, 0, 'next')).toBe(0);
    expect(stepLightboxIndex(0, 3, 'prev')).toBe(2);
    expect(stepLightboxIndex(2, 3, 'next')).toBe(0);

    const validated = validateImageUploadCandidates(
      [
        { name: 'good.jpg', type: 'image/jpeg', size: 1024 },
        { name: 'empty.png', type: 'image/png', size: 0 },
        { name: 'huge.webp', type: 'image/webp', size: 5 * 1024 * 1024 },
        { name: 'vector.svg', type: 'image/svg+xml', size: 200 },
        { name: '', type: '', size: 100 },
      ],
      { maxBytes: 2 * 1024 * 1024 }
    );
    expect(validated.accepted.map((f) => f.name)).toEqual(['good.jpg']);
    expect(validated.errors).toHaveLength(4);
  });
});

describe('apiError pure helpers and error envelope parsing', () => {
  it('normalizes trailing slashes, asset bases, and structured vs unstructured HTTP error envelopes', async () => {
    const { normalizeAssetBase, parseErrorEnvelope, stripTrailingSlash } = await import(
      './httpWiki/apiError.js'
    );
    expect(stripTrailingSlash('https://archive.example/')).toBe('https://archive.example');
    expect(stripTrailingSlash('https://archive.example')).toBe('https://archive.example');
    expect(normalizeAssetBase()).toBe('/');
    expect(normalizeAssetBase('')).toBe('/');
    expect(normalizeAssetBase('/assets')).toBe('/assets/');
    expect(normalizeAssetBase('/assets/')).toBe('/assets/');

    const structured = await parseErrorEnvelope(
      new Response(
        JSON.stringify({ error: { code: 'CONFLICT', message: 'Stale revision', details: { rev: 2 } } }),
        { status: 409, statusText: 'Conflict' }
      )
    );
    expect(structured).toBeInstanceOf(ApiClientError);
    expect(structured.status).toBe(409);
    expect(structured.code).toBe('CONFLICT');
    expect(structured.details).toEqual({ rev: 2 });

    for (const fallbackBody of [
      JSON.stringify(null),
      JSON.stringify({ ok: false }),
      JSON.stringify({ error: null }),
      JSON.stringify({ error: { code: '', message: 'No code' } }),
      JSON.stringify({ error: { code: 'ERR', message: '' } }),
      'Gateway Timeout Plaintext',
    ]) {
      const parsed = await parseErrorEnvelope(
        new Response(fallbackBody, { status: 502, statusText: 'Bad Gateway' })
      );
      expect(parsed.code).toBe('HTTP_502');
      expect(parsed.message).toBe('HTTP 502 Bad Gateway');
    }
  });
});

describe('resolvePluginRequestCredentials & plugin client credentials option', () => {
  it('defaults to same-origin for relative URLs, include for explicit overrides, and passes credentials through all plugin HTTP clients', async () => {
    expect(resolvePluginRequestCredentials('')).toBe('same-origin');
    expect(resolvePluginRequestCredentials('/api')).toBe('same-origin');
    expect(resolvePluginRequestCredentials('https://api.example.test', 'include')).toBe('include');
    expect(resolvePluginRequestCredentials('https://api.example.test', 'omit')).toBe('omit');

    const seenCredentials: Array<RequestCredentials | undefined> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seenCredentials.push(init?.credentials);
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('open-finance/summary')) {
        return new Response(null, { status: 404 });
      }
      if (url.includes('book-publishing/status')) {
        return new Response(null, { status: 404 });
      }
      if (url.includes('/api/plugins/recipes')) {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const apiClient = createHttpPluginApiClient({
      apiBaseUrl: 'https://api.example.test',
      credentials: 'include',
      fetchImpl,
    });
    await apiClient.requestJson('/ok', (raw) => raw);

    const ofClient = createHttpOpenFinanceClient({
      apiBaseUrl: 'https://api.example.test',
      credentials: 'include',
      fetchImpl,
    });
    await ofClient.getPublicSummary({ cache: 'no-store' });

    const bpClient = createHttpBookPublishingClient({
      apiBaseUrl: 'https://api.example.test',
      credentials: 'include',
      fetchImpl,
    });
    await bpClient.getStatus();

    const recipesClient = createHttpRecipesClient({
      apiBaseUrl: 'https://api.example.test',
      credentials: 'include',
      fetchImpl,
    });
    await recipesClient.listRecipes();

    expect(seenCredentials).toEqual(['include', 'include', 'include', 'include']);
  });

  it('resolves relative recipe photo/cover URLs and book publishing artifact URLs through apiBaseUrl', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/plugins/recipes')) {
        return new Response(
          JSON.stringify({
            recipes: [{ ...SAMPLE_RECIPE, cover_photo_url: '/api/plugins/recipes/photos/pho_1' }],
            total: 1,
            limit: 24,
            offset: 0,
            facets: { courses: ['bread'], tags: [] },
            display: { show_home_widget: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/plugins/recipes/sourdough-boule')) {
        return new Response(
          JSON.stringify({
            recipe: { ...SAMPLE_RECIPE, cover_photo_url: '/api/plugins/recipes/photos/pho_1' },
            photos: [
              {
                id: 'pho_1',
                recipe_id: 'rec_1',
                url: '/api/plugins/recipes/photos/pho_1',
                mime_type: 'image/jpeg',
                size_bytes: 1200,
                width: 800,
                height: 600,
                orientation: 1,
                caption: 'Front',
                card_side: 'front',
                sort_order: 0,
                uploaded_by_name: 'Clara',
                created_at: '2026-11-27T10:00:00.000Z',
              },
            ],
            viewer_has_starred: false,
            permissions: {
              can_edit: false,
              can_delete: false,
              can_upload: false,
              can_star: false,
              can_comment: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/plugins/book-publishing/compile')) {
        return new Response(
          JSON.stringify({
            report: {
              title: 'Family Book',
              subtitle: '',
              familyName: 'Alder',
              edition: 'public',
              colophonNotice: 'Public Edition',
              generatedAt: '2026-11-27T10:00:00.000Z',
              counts: {
                includedPeople: 2,
                excludedLivingPeople: 0,
                includedEvents: 1,
                includedPlaces: 1,
                includedSources: 1,
                includedMedia: 0,
                excludedLivingMedia: 0,
                includedNarratives: 0,
                finalPageCount: 24,
              },
              coverDimensions: {
                totalWidthIn: 24,
                totalHeightIn: 10,
                spineWidthIn: 0.25,
                allowSpineText: false,
                providerSku: '1100X0850FCPRESSCW080CW444GXX',
              },
              warnings: [],
              privacy: {
                edition: 'public',
                livingPeopleExcluded: 0,
                livingMediaExcluded: 0,
                reviewFlagsDetected: 0,
                reviewFlagsAcknowledged: false,
              },
            },
            renderer: 'deterministic-pdf',
            artifacts: {
              interior_pdf_url: '/api/plugins/book-publishing/artifacts/tok-int',
              cover_pdf_url: '/api/plugins/book-publishing/artifacts/tok-cov',
              interior_bytes: 2048,
              cover_bytes: 1024,
              expires_at: '2026-11-27T12:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    };

    const recipesClient = createHttpRecipesClient({
      apiBaseUrl: 'https://api.archive.example/',
      fetchImpl,
    });
    const list = await recipesClient.listRecipes();
    expect(list?.recipes[0]?.cover_photo_url).toBe(
      'https://api.archive.example/api/plugins/recipes/photos/pho_1'
    );
    const detail = await recipesClient.getRecipe('sourdough-boule');
    expect(detail?.recipe.cover_photo_url).toBe(
      'https://api.archive.example/api/plugins/recipes/photos/pho_1'
    );
    expect(detail?.photos[0]?.url).toBe('https://api.archive.example/api/plugins/recipes/photos/pho_1');

    const bpClient = createHttpBookPublishingClient({
      apiBaseUrl: 'https://api.archive.example/',
      fetchImpl,
    });
    const compiled = await bpClient.compileBook({
      trimPreset: 'us-letter-landscape',
      binding: 'hardcover-casewrap-glossy',
      paperStock: '80lb-coated-white-color',
      edition: 'public',
    });
    expect(compiled.artifacts.interior_pdf_url).toBe(
      'https://api.archive.example/api/plugins/book-publishing/artifacts/tok-int'
    );
    expect(compiled.artifacts.cover_pdf_url).toBe(
      'https://api.archive.example/api/plugins/book-publishing/artifacts/tok-cov'
    );
  });
});
