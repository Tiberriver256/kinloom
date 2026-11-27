import { describe, expect, it } from 'vitest';
import type { UiRecipeDetail } from '../lib/recipesModel.js';
import { ApiClientError } from './httpWiki/httpClient.js';
import { createHttpPluginApiClient } from './pluginApiClient.js';
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
});
