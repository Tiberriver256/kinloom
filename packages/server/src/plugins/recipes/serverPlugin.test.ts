import { parseKinloomConfig, type RevisionAuthor } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../../adapters/inMemory.js';
import { sha256Hex } from '../../crypto.js';
import { createKinloomServer } from '../../http/router.js';
import { getSessionCookieName, signSessionToken } from '../../http/session.js';
import { InMemoryRecipesRepository } from './inMemoryRecipesRepository.js';
import { CreateRecipeInputSchema, deriveRecipeActorKey, RECIPES_PLUGIN_ID } from './schemas.js';
import {
  computeRecipePermissions,
  createRecipesServerPlugin,
  DEFAULT_RECIPES_RUNTIME_SETTINGS,
} from './serverPlugin.js';

const SESSION_SECRET = 'kinloom-recipes-server-plugin-test-secret-0123456789';

const SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Synthetic Recipe Archive',
    familyName: 'Archive Example',
    gedcomSourceName: 'RECIPE_TEST',
  },
});

const SEED_AUTHOR: RevisionAuthor = {
  author_id: 'system:seed',
  author_name: 'Seed',
  author_type: 'system_seed',
};

async function createTestHarness(options?: {
  readonly registerPlugin?: boolean;
  readonly enabled?: boolean;
}) {
  const ports = createInMemoryServerPorts(SITE_CONFIG, {
    initialIso: '2026-11-27T12:00:00.000Z',
  });
  const recipesRepo = new InMemoryRecipesRepository();

  await ports.repository.commitAtomicMutations({
    batch_id: null,
    author: SEED_AUTHOR,
    nowIso: ports.clock.nowIso(),
    operations: [
      {
        entity_type: 'person',
        entity_id: 'p_ada',
        slug: 'ada-lovelace',
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed deceased ancestor',
        has_primary_source: true,
        before_json: null,
        after_json: {
          id: 'p_ada',
          slug: 'ada-lovelace',
          full_name: 'Ada Lovelace',
          given_name: 'Ada',
          surname: 'Lovelace',
          alt_names: ['Augusta'],
          sex: 'F',
          is_living: false,
          lineage_group: 'pivot_ancestor',
          birth_edtf: '1815-12-10',
          death_edtf: '1852-11-27',
          portrait_url: null,
        },
      },
      {
        entity_type: 'person',
        entity_id: 'p_living',
        slug: 'living-relative',
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed living relative',
        has_primary_source: true,
        before_json: null,
        after_json: {
          id: 'p_living',
          slug: 'living-relative',
          full_name: 'Clara Example',
          given_name: 'Clara',
          surname: 'Example',
          alt_names: [],
          sex: 'F',
          is_living: true,
          lineage_group: 'descendant',
          birth_edtf: '1990-05-01',
          death_edtf: null,
          portrait_url: null,
        },
      },
    ],
  });

  await ports.repository.upsertUser({
    email: 'admin@archive.example.test',
    display_name: 'Archive Steward',
    role: 'admin',
    added_by: 'bootstrap',
    added_at: ports.clock.nowIso(),
    last_login_at: null,
  });
  await ports.repository.upsertUser({
    email: 'editor@archive.example.test',
    display_name: 'Clara Baker',
    role: 'editor',
    added_by: 'admin@archive.example.test',
    added_at: ports.clock.nowIso(),
    last_login_at: null,
  });
  await ports.repository.createInvite({
    token: 'invite-recipes-2026',
    label: 'Cousin Preview',
    created_by: 'admin@archive.example.test',
    created_at: ports.clock.nowIso(),
    expires_at: '2027-11-27T12:00:00.000Z',
    revoked_at: null,
    uses: 0,
    last_used_at: null,
  });

  const plugins =
    options?.registerPlugin === false
      ? []
      : [createRecipesServerPlugin({ enabled: options?.enabled, repository: recipesRepo })];

  const server = createKinloomServer({
    siteConfig: SITE_CONFIG,
    ports: { ...ports, plugins },
    sessionSecret: SESSION_SECRET,
    bootstrapAdminEmail: 'admin@archive.example.test',
  });

  const cookieForUser = async (email: string, role: 'admin' | 'editor'): Promise<string> => {
    const token = await signSessionToken({
      secret: SESSION_SECRET,
      clock: ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email,
        display_name: role === 'admin' ? 'Archive Steward' : 'Clara Baker',
        role,
      },
    });
    return `${getSessionCookieName(false)}=${token}`;
  };

  const cookieForInvite = async (): Promise<string> => {
    const token = await signSessionToken({
      secret: SESSION_SECRET,
      clock: ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'invite_viewer',
        invite_token: 'invite-recipes-2026',
        label: 'Cousin Preview',
      },
    });
    return `${getSessionCookieName(false)}=${token}`;
  };

  return { ports, recipesRepo, server, cookieForUser, cookieForInvite };
}

describe('createRecipesServerPlugin (Issue #47 read API & #44 settings)', () => {
  it('stays completely off by default when unregistered or explicitly disabled', async () => {
    const offUnregistered = await createTestHarness({ registerPlugin: false });
    const cookie = await offUnregistered.cookieForUser('editor@archive.example.test', 'editor');

    for (const path of [
      '/api/plugins/recipes',
      '/api/plugins/recipes/honey-biscuits',
      '/api/plugins/recipes/by-person/p_ada',
    ]) {
      const res = await offUnregistered.server.fetch(
        new Request(`http://localhost${path}`, { headers: { cookie } })
      );
      expect(res.status).toBe(404);
    }

    const disabledPlugin = createRecipesServerPlugin({ enabled: false });
    expect(disabledPlugin.status).toBe('disabled');
    expect(disabledPlugin.routes).toBeUndefined();
    expect(disabledPlugin.settingsSchema).toBeUndefined();
    expect(disabledPlugin.databaseNamespace).toBeUndefined();
    expect(disabledPlugin.migrations).toBeUndefined();

    const offDisabled = await createTestHarness({ enabled: false });
    const resDisabled = await offDisabled.server.fetch(
      new Request('http://localhost/api/plugins/recipes', { headers: { cookie } })
    );
    expect(resDisabled.status).toBe(404);
  });

  it('serves catalog, detail, and by-person read routes with filters, sorting, pagination, and zero email leaks', async () => {
    const { recipesRepo, server, cookieForUser, cookieForInvite } = await createTestHarness();

    const r1 = await recipesRepo.createRecipe({
      id: 'rec_1',
      data: CreateRecipeInputSchema.parse({
        title: 'Oatmeal Honey Biscuits',
        summary: 'Warm cast-iron biscuits from the 1840 notebook.',
        story_md: 'Baked every Sunday morning in winter.',
        ingredients: [
          { id: 'ing_1', quantity: '2', unit: 'cups', item: 'rolled oats', note: '', group: 'Dry' },
        ],
        steps: [{ id: 'stp_1', instruction: 'Preheat oven to 400F.', note: 'Use middle rack.' }],
        prep_minutes: 15,
        cook_minutes: 20,
        servings: '12 biscuits',
        course: 'bread',
        tags: ['heirloom', 'winter'],
        provenance_note: 'Copied from kitchen ledger page 14.',
        source_era: 'c. 1840',
        attributed_person_id: 'p_ada',
      }),
      actor: { id: 'editor@archive.example.test', name: 'Clara Baker' },
      nowIso: '2026-11-27T10:00:00.000Z',
    });

    await recipesRepo.addPhoto({
      id: 'pho_1',
      recipe_id: r1.id,
      r2_key: 'plugins/recipes/rec_1/pho_1.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 2048,
      sha256: 'a'.repeat(64),
      width: 800,
      height: 600,
      orientation: 1,
      caption: 'Front of card',
      card_side: 'front',
      uploaded_by: { id: 'editor@archive.example.test', name: 'Clara Baker' },
      nowIso: '2026-11-27T10:05:00.000Z',
    });

    const r2 = await recipesRepo.createRecipe({
      id: 'rec_2',
      data: CreateRecipeInputSchema.parse({
        title: 'Apple Cider Pie',
        summary: 'Spiced autumn pie with lattice crust.',
        course: 'dessert',
        tags: ['autumn', 'heirloom'],
        attributed_person_id: 'p_living',
      }),
      actor: { id: 'admin@archive.example.test', name: 'Archive Steward' },
      nowIso: '2026-11-27T11:00:00.000Z',
    });

    const editorActorKey = await deriveRecipeActorKey({
      kind: 'user',
      email: 'editor@archive.example.test',
      display_name: 'Clara Baker',
      role: 'editor',
    });
    expect(editorActorKey).not.toBeNull();
    await recipesRepo.starRecipe(r1.id, editorActorKey ?? '', '2026-11-27T11:30:00.000Z');

    // Anonymous is rejected with 401
    const anonRes = await server.fetch(new Request('http://localhost/api/plugins/recipes'));
    expect(anonRes.status).toBe(401);

    const editorCookie = await cookieForUser('editor@archive.example.test', 'editor');
    const inviteCookie = await cookieForInvite();

    // Full catalog read
    const listRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes?sort=stars', {
        headers: { cookie: editorCookie },
      })
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain('editor@archive.example.test');
    expect(listText).not.toContain('admin@archive.example.test');
    expect(listText).not.toContain('r2_key');
    const listJson = JSON.parse(listText);
    expect(listJson.total).toBe(2);
    expect(listJson.recipes[0].slug).toBe('oatmeal-honey-biscuits');
    expect(listJson.recipes[0].viewer_has_starred).toBe(true);
    expect(listJson.recipes[0].cover_photo_url).toBe('/api/plugins/recipes/photos/pho_1');
    expect(listJson.recipes[0].attributed_person).toEqual({
      id: 'p_ada',
      slug: 'ada-lovelace',
      full_name: 'Ada Lovelace',
    });
    // Living-person attribution is redacted on read!
    expect(listJson.recipes[1].attributed_person_id).toBeNull();
    expect(listJson.recipes[1].attributed_person).toBeNull();
    expect(listJson.facets.courses).toEqual(['bread', 'dessert']);
    expect(listJson.facets.tags).toEqual(['autumn', 'heirloom', 'winter']);

    // Search + course/category + tag + favorites + alpha sort + pagination
    const filteredRes = await server.fetch(
      new Request(
        'http://localhost/api/plugins/recipes?q=biscuits&category=bread&tag=winter&favorites=1&sort=alpha&limit=5&offset=0',
        { headers: { cookie: editorCookie } }
      )
    );
    expect(filteredRes.status).toBe(200);
    const filteredJson = (await filteredRes.json()) as { total: number; recipes: Array<{ id: string }> };
    expect(filteredJson.total).toBe(1);
    expect(filteredJson.recipes[0].id).toBe(r1.id);

    // Detail endpoint by slug (and check zero email leaks)
    const detailRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes/oatmeal-honey-biscuits', {
        headers: { cookie: editorCookie },
      })
    );
    expect(detailRes.status).toBe(200);
    const detailText = await detailRes.text();
    expect(detailText).not.toContain('editor@archive.example.test');
    expect(detailText).not.toContain('plugins/recipes/rec_1/pho_1.jpg');
    const detailJson = JSON.parse(detailText);
    expect(detailJson.recipe.ingredients).toHaveLength(1);
    expect(detailJson.recipe.steps).toHaveLength(1);
    expect(detailJson.photos).toHaveLength(1);
    expect(detailJson.photos[0].url).toBe('/api/plugins/recipes/photos/pho_1');
    expect(detailJson.viewer_has_starred).toBe(true);
    expect(detailJson.permissions).toEqual({
      can_edit: true,
      can_delete: true,
      can_upload: true,
      can_star: true,
      can_comment: true,
    });

    // Detail endpoint by ID with living person redaction
    const detailLivingRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r2.id}`, {
        headers: { cookie: inviteCookie },
      })
    );
    expect(detailLivingRes.status).toBe(200);
    const detailLivingJson = (await detailLivingRes.json()) as {
      recipe: { attributed_person: unknown };
      permissions: { can_edit: boolean };
    };
    expect(detailLivingJson.recipe.attributed_person).toBeNull();
    expect(detailLivingJson.permissions.can_edit).toBe(false);

    // by-person endpoint for deceased ancestor
    const byAdaRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes/by-person/p_ada?limit=6', {
        headers: { cookie: inviteCookie },
      })
    );
    expect(byAdaRes.status).toBe(200);
    const byAdaJson = (await byAdaRes.json()) as { total: number; recipes: Array<{ id: string }> };
    expect(byAdaJson.total).toBe(1);
    expect(byAdaJson.recipes[0].id).toBe(r1.id);

    // by-person endpoint for living person returns empty
    const byLivingRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes/by-person/p_living', {
        headers: { cookie: editorCookie },
      })
    );
    expect(byLivingRes.status).toBe(200);
    const byLivingJson = (await byLivingRes.json()) as { total: number; recipes: unknown[] };
    expect(byLivingJson.recipes).toEqual([]);
    expect(byLivingJson.total).toBe(0);

    // by-person endpoint for nonexistent person returns empty
    const byMissingRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes/by-person/p_missing', {
        headers: { cookie: editorCookie },
      })
    );
    expect(byMissingRes.status).toBe(200);
    const byMissingJson = (await byMissingRes.json()) as { recipes: unknown[] };
    expect(byMissingJson.recipes).toEqual([]);

    // Validation & 404 edge cases
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes?course=invalid', {
            headers: { cookie: editorCookie },
          })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes?sort=invalid', {
            headers: { cookie: editorCookie },
          })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes?limit=abc', { headers: { cookie: editorCookie } })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes?limit=500', { headers: { cookie: editorCookie } })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/does-not-exist', {
            headers: { cookie: editorCookie },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/extra/nested/path', {
            headers: { cookie: editorCookie },
          })
        )
      ).status
    ).toBe(404);
  });

  it('handles agent bearer favorites=1 safely and supports public readMinRole', async () => {
    const { ports, recipesRepo, server } = await createTestHarness();
    await recipesRepo.createRecipe({
      id: 'rec_agent_1',
      data: CreateRecipeInputSchema.parse({ title: 'Molasses Cookies', course: 'dessert', tags: ['winter'] }),
      actor: { id: 'admin@archive.example.test', name: 'Archive Steward' },
      nowIso: '2026-11-27T10:00:00.000Z',
    });

    const rawAgentToken = 'kl_agent_recipes_read_token_test';
    await ports.repository.createAgentToken({
      token_id: 'tok_recipes_reader',
      token_hash: await sha256Hex(rawAgentToken),
      label: 'Recipes Reader Agent',
      scope: 'read_backup',
      created_by: 'admin@archive.example.test',
      created_at: ports.clock.nowIso(),
      revoked_at: null,
    });

    const favAgentRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes?favorites=1', {
        headers: { authorization: `Bearer ${rawAgentToken}` },
      })
    );
    expect(favAgentRes.status).toBe(200);
    const favAgentJson = (await favAgentRes.json()) as {
      recipes: unknown[];
      total: number;
      facets: { courses: string[] };
    };
    expect(favAgentJson.recipes).toEqual([]);
    expect(favAgentJson.total).toBe(0);
    expect(favAgentJson.facets.courses).toEqual(['dessert']);

    // Verify public readMinRole allows anonymous reads
    const publicServer = createKinloomServer({
      siteConfig: SITE_CONFIG,
      ports: {
        ...ports,
        plugins: [createRecipesServerPlugin({ repository: recipesRepo, readMinRole: 'public' })],
      },
      sessionSecret: SESSION_SECRET,
      bootstrapAdminEmail: 'admin@archive.example.test',
    });
    const publicRes = await publicServer.fetch(new Request('http://localhost/api/plugins/recipes'));
    expect(publicRes.status).toBe(200);
  });

  it('integrates with #44 declarative plugin settings and live readonly counters', async () => {
    const { recipesRepo, server, cookieForUser } = await createTestHarness();
    const adminCookie = await cookieForUser('admin@archive.example.test', 'admin');
    const editorCookie = await cookieForUser('editor@archive.example.test', 'editor');

    await recipesRepo.createRecipe({
      id: 'rec_settings_1',
      data: CreateRecipeInputSchema.parse({ title: 'Buttermilk Cornbread' }),
      actor: { id: 'admin@archive.example.test', name: 'Archive Steward' },
      nowIso: '2026-11-27T10:00:00.000Z',
    });

    const settingsRes = await server.fetch(
      new Request('http://localhost/api/admin/plugin-settings', {
        headers: { cookie: adminCookie },
      })
    );
    expect(settingsRes.status).toBe(200);
    const settingsJson = (await settingsRes.json()) as {
      plugins: Array<{
        plugin_id: string;
        readonly_values: Record<string, unknown>;
        values: Record<string, unknown>;
      }>;
    };
    const recipesSnap = settingsJson.plugins.find((p) => p.plugin_id === RECIPES_PLUGIN_ID);
    expect(recipesSnap).toBeDefined();
    expect(recipesSnap?.readonly_values).toEqual({
      storage_adapter: 'in-memory',
      recipe_count: 1,
    });
    expect(recipesSnap?.values.show_home_widget).toBe(true);

    // Update settings via #44 endpoint
    const updateRes = await server.fetch(
      new Request(`http://localhost/api/admin/plugin-settings/${RECIPES_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            show_home_widget: false,
            create_edit_min_role: 'admin',
            comment_min_role: 'disabled',
          },
        }),
      })
    );
    expect(updateRes.status).toBe(200);

    // Catalog reflects updated show_home_widget, detail reflects updated permissions
    const listRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', { headers: { cookie: editorCookie } })
    );
    const listJson = (await listRes.json()) as { display: { show_home_widget: boolean } };
    expect(listJson.display).toEqual({ show_home_widget: false });

    const detailRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes/buttermilk-cornbread', {
        headers: { cookie: editorCookie },
      })
    );
    const detailJson = (await detailRes.json()) as {
      permissions: { can_edit: boolean; can_comment: boolean };
    };
    expect(detailJson.permissions.can_edit).toBe(false);
    expect(detailJson.permissions.can_comment).toBe(false);
  });

  it('computes permissions accurately across all principal kinds and setting combinations', () => {
    const recipe = { created_by_id: 'owner@archive.example.test' };
    expect(computeRecipePermissions({ kind: 'anonymous' }, recipe, DEFAULT_RECIPES_RUNTIME_SETTINGS)).toEqual(
      {
        can_edit: false,
        can_delete: false,
        can_upload: false,
        can_star: false,
        can_comment: false,
      }
    );
    expect(
      computeRecipePermissions(
        { kind: 'agent', token_id: 'tok_1', label: 'Agent', scope: 'read_backup' },
        recipe,
        DEFAULT_RECIPES_RUNTIME_SETTINGS
      )
    ).toEqual({
      can_edit: false,
      can_delete: false,
      can_upload: false,
      can_star: false,
      can_comment: false,
    });
    expect(
      computeRecipePermissions({ kind: 'invite_viewer', invite_token: 'inv_1', label: 'Invite' }, recipe, {
        ...DEFAULT_RECIPES_RUNTIME_SETTINGS,
        star_min_role: 'viewer',
      }).can_star
    ).toBe(true);
    expect(
      computeRecipePermissions(
        { kind: 'user', email: 'other@archive.example.test', display_name: 'Other', role: 'editor' },
        recipe,
        {
          ...DEFAULT_RECIPES_RUNTIME_SETTINGS,
          upload_min_role: 'admin',
          comment_min_role: 'admin',
        }
      )
    ).toEqual({
      can_edit: true,
      can_delete: false,
      can_upload: false,
      can_star: true,
      can_comment: false,
    });
    expect(
      computeRecipePermissions(
        { kind: 'user', email: 'admin@archive.example.test', display_name: 'Admin', role: 'admin' },
        recipe,
        {
          ...DEFAULT_RECIPES_RUNTIME_SETTINGS,
          create_edit_min_role: 'admin',
          upload_min_role: 'admin',
          comment_min_role: 'admin',
        }
      )
    ).toEqual({
      can_edit: true,
      can_delete: true,
      can_upload: true,
      can_star: true,
      can_comment: true,
    });
  });
});
