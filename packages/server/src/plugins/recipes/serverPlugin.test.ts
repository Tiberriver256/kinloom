import { parseKinloomConfig, type RevisionAuthor } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../../adapters/inMemory.js';
import { sha256Hex } from '../../crypto.js';
import type { KinloomServerPlugin, ServerSecurityEvent } from '../../http/pluginLifecycle.js';
import { createKinloomServer } from '../../http/router.js';
import { getSessionCookieName, signSessionToken } from '../../http/session.js';
import { computeCrc32 } from '../../services/imageMetadataStripper.js';
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

  const securityEvents: ServerSecurityEvent[] = [];
  const securityCapturePlugin: KinloomServerPlugin = {
    id: 'test-security-capture',
    name: 'Test Security Capture',
    onSecurityEvent(event) {
      securityEvents.push(event);
    },
  };

  const plugins =
    options?.registerPlugin === false
      ? [securityCapturePlugin]
      : [
          securityCapturePlugin,
          createRecipesServerPlugin({ enabled: options?.enabled, repository: recipesRepo }),
        ];

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

  return { ports, recipesRepo, server, securityEvents, cookieForUser, cookieForInvite };
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

function buildTestPngWithExif(width: number, height: number, secretExif: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const makeChunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = new Uint8Array(4 + data.byteLength);
    body.set(enc.encode(type), 0);
    body.set(data, 4);
    const crc = computeCrc32(body);
    const out = new Uint8Array(12 + data.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.byteLength, false);
    out.set(body, 4);
    dv.setUint32(8 + data.byteLength, crc, false);
    return out;
  };
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const parts = [
    sig,
    makeChunk('IHDR', ihdrData),
    makeChunk('eXIf', enc.encode(secretExif)),
    makeChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    makeChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe('createRecipesServerPlugin (Issue #48 photo upload, EXIF stripping, serving, RBAC, and telemetry)', () => {
  it('uploads, strips EXIF, serves via both canonical and slug routes with safe headers, edits, reorders, and deletes photos cleanly', async () => {
    const { ports, recipesRepo, server, cookieForUser, cookieForInvite } = await createTestHarness();
    const editorCookie = await cookieForUser('editor@archive.example.test', 'editor');
    const inviteCookie = await cookieForInvite();

    const recipe = await recipesRepo.createRecipe({
      id: 'rec_photo_1',
      data: CreateRecipeInputSchema.parse({
        title: 'Grandmother Rye Bread',
        summary: 'Caraway rye loaf baked in cast iron.',
        course: 'bread',
      }),
      actor: { id: 'editor@archive.example.test', name: 'Clara Baker' },
      nowIso: '2026-11-27T12:00:00.000Z',
    });

    const otherRecipe = await recipesRepo.createRecipe({
      id: 'rec_photo_other',
      data: CreateRecipeInputSchema.parse({ title: 'Mint Tea', course: 'beverage' }),
      actor: { id: 'admin@archive.example.test', name: 'Archive Steward' },
      nowIso: '2026-11-27T12:01:00.000Z',
    });

    const pngWithGps = buildTestPngWithExif(640, 480, 'SECRET_GPS_LAT_39_78_LON_89_65');
    const form1 = new FormData();
    form1.set('file', new File([pngWithGps], 'card-front.png', { type: 'image/png' }));
    form1.set('caption', 'Front of handwritten card');
    form1.set('card_side', 'front');

    const uploadRes1 = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
        body: form1,
      })
    );
    expect(uploadRes1.status).toBe(201);
    const uploadText1 = await uploadRes1.text();
    expect(uploadText1).not.toContain('r2_key');
    expect(uploadText1).not.toContain('editor@archive.example.test');
    const uploadJson1 = JSON.parse(uploadText1) as {
      photo: { id: string; url: string; width: number; height: number; card_side: string; caption: string };
      cover_photo_id: string;
    };
    expect(uploadJson1.cover_photo_id).toBe(uploadJson1.photo.id);
    expect(uploadJson1.photo.width).toBe(640);
    expect(uploadJson1.photo.height).toBe(480);
    expect(uploadJson1.photo.card_side).toBe('front');
    expect(uploadJson1.photo.caption).toBe('Front of handwritten card');

    // Verify stored R2 object exists and has EXIF/GPS stripped
    const r2Key1 = `plugins/recipes/${recipe.id}/${uploadJson1.photo.id}.png`;
    expect((await ports.mediaStore.head(r2Key1)).exists).toBe(true);

    // Serve photo via canonical URL (/api/plugins/recipes/photos/:photoId)
    const getCanonical = await server.fetch(
      new Request(`http://localhost${uploadJson1.photo.url}`, { headers: { cookie: inviteCookie } })
    );
    expect(getCanonical.status).toBe(200);
    expect(getCanonical.headers.get('content-type')).toBe('image/png');
    expect(getCanonical.headers.get('content-disposition')).toBe(
      `inline; filename="recipe-card-${uploadJson1.photo.id}.png"`
    );
    expect(getCanonical.headers.get('x-content-type-options')).toBe('nosniff');
    expect(getCanonical.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(getCanonical.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const servedBytes = new Uint8Array(await getCanonical.arrayBuffer());
    expect(new TextDecoder('latin1').decode(servedBytes)).not.toContain('SECRET_GPS_LAT_39_78');

    // ETag 304 support
    const etag = getCanonical.headers.get('etag');
    expect(etag).toBeTruthy();
    const get304 = await server.fetch(
      new Request(`http://localhost${uploadJson1.photo.url}`, {
        headers: { cookie: inviteCookie, 'if-none-match': etag ?? '' },
      })
    );
    expect(get304.status).toBe(304);

    // Serve photo via recipe-scoped slug URL (/api/plugins/recipes/:slug/photos/:photoId)
    const getScoped = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos/${uploadJson1.photo.id}`, {
        headers: { cookie: inviteCookie },
      })
    );
    expect(getScoped.status).toBe(200);
    expect(getScoped.headers.get('content-type')).toBe('image/png');

    // Cross-recipe photo lookup returns 404
    const getWrongRecipe = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${otherRecipe.slug}/photos/${uploadJson1.photo.id}`, {
        headers: { cookie: inviteCookie },
      })
    );
    expect(getWrongRecipe.status).toBe(404);

    // Upload second photo with set_cover='true' and explicit sort_order
    const form2 = new FormData();
    form2.set(
      'file',
      new File([buildTestPngWithExif(320, 240, 'GPS_2')], 'card-back.png', { type: 'image/png' })
    );
    form2.set('caption', 'Back of card');
    form2.set('card_side', 'back');
    form2.set('set_cover', 'true');
    form2.set('sort_order', '2');

    const uploadRes2 = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
        body: form2,
      })
    );
    expect(uploadRes2.status).toBe(201);
    const uploadJson2 = (await uploadRes2.json()) as {
      photo: { id: string; sort_order: number };
      cover_photo_id: string;
    };
    expect(uploadJson2.cover_photo_id).toBe(uploadJson2.photo.id);
    expect(uploadJson2.photo.sort_order).toBe(2);

    // PATCH photo caption, card_side, and set_cover
    const patchRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos/${uploadJson1.photo.id}`, {
        method: 'PATCH',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ caption: 'Card front (transcribed)', card_side: 'page', set_cover: true }),
      })
    );
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as {
      photo: { caption: string; card_side: string };
      cover_photo_id: string;
    };
    expect(patchJson.photo.caption).toBe('Card front (transcribed)');
    expect(patchJson.photo.card_side).toBe('page');
    expect(patchJson.cover_photo_id).toBe(uploadJson1.photo.id);

    // Reorder photos
    const reorderRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos/reorder`, {
        method: 'POST',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ photo_ids: [uploadJson2.photo.id, uploadJson1.photo.id] }),
      })
    );
    expect(reorderRes.status).toBe(200);
    const reorderJson = (await reorderRes.json()) as { photos: Array<{ id: string }> };
    expect(reorderJson.photos.map((p) => p.id)).toEqual([uploadJson2.photo.id, uploadJson1.photo.id]);

    // Delete first photo: removes DB row & deletes R2 object
    const deleteRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos/${uploadJson1.photo.id}`, {
        method: 'DELETE',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
      })
    );
    expect(deleteRes.status).toBe(204);
    expect((await ports.mediaStore.head(r2Key1)).exists).toBe(false);

    // Subsequent GET returns 404
    expect(
      (
        await server.fetch(
          new Request(`http://localhost${uploadJson1.photo.url}`, { headers: { cookie: inviteCookie } })
        )
      ).status
    ).toBe(404);
  });

  it('enforces CSRF, RBAC, #44 settings limits, magic-byte validation, and emits #31 media.upload.rejected telemetry', async () => {
    const { ports, recipesRepo, server, securityEvents, cookieForUser, cookieForInvite } =
      await createTestHarness();
    const adminCookie = await cookieForUser('admin@archive.example.test', 'admin');
    const editorCookie = await cookieForUser('editor@archive.example.test', 'editor');
    const inviteCookie = await cookieForInvite();

    const recipe = await recipesRepo.createRecipe({
      id: 'rec_sec_1',
      data: CreateRecipeInputSchema.parse({ title: 'Saffron Buns', course: 'bread' }),
      actor: { id: 'admin@archive.example.test', name: 'Archive Steward' },
      nowIso: '2026-11-27T12:00:00.000Z',
    });

    // Cross-origin CSRF blocked -> 403
    const csrfForm = new FormData();
    csrfForm.set('file', new File([buildTestPngWithExif(16, 16, 'x')], 'x.png', { type: 'image/png' }));
    const csrfRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'https://evil.example' },
        body: csrfForm,
      })
    );
    expect(csrfRes.status).toBe(403);

    // Invite viewer cannot upload -> 403
    const inviteRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: inviteCookie, origin: 'http://localhost' },
        body: csrfForm,
      })
    );
    expect(inviteRes.status).toBe(403);

    // Agent bearer token cannot upload (human-only) -> 403 + auth.write.forbidden
    const rawAgentToken = 'kl_agent_photo_write_test';
    await ports.repository.createAgentToken({
      token_id: 'tok_agent_photo',
      token_hash: await sha256Hex(rawAgentToken),
      label: 'Agent Photo Test',
      scope: 'write_batch',
      created_by: 'admin@archive.example.test',
      created_at: ports.clock.nowIso(),
      revoked_at: null,
    });
    const agentRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rawAgentToken}` },
        body: csrfForm,
      })
    );
    expect(agentRes.status).toBe(403);

    // Spoofed HTML labeled as image/jpeg -> 415 + media.upload.rejected
    const spoofForm = new FormData();
    spoofForm.set(
      'file',
      new File(['<html><script>alert(1)</script></html>'], 'spoof.jpg', { type: 'image/jpeg' })
    );
    const spoofRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
        body: spoofForm,
      })
    );
    expect(spoofRes.status).toBe(415);

    // SVG upload -> 415 + media.upload.rejected
    const svgForm = new FormData();
    svgForm.set(
      'file',
      new File(['<svg><script>alert(1)</script></svg>'], 'card.svg', { type: 'image/svg+xml' })
    );
    const svgRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
        body: svgForm,
      })
    );
    expect(svgRes.status).toBe(415);

    // Tighten #44 settings: upload_min_role='admin', max_photo_mb=1, max_photos_per_recipe=1
    const updateSettings = await server.fetch(
      new Request(`http://localhost/api/admin/plugin-settings/${RECIPES_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            upload_min_role: 'admin',
            max_photo_mb: 1,
            max_photos_per_recipe: 1,
          },
        }),
      })
    );
    expect(updateSettings.status).toBe(200);

    // Editor now blocked when upload_min_role='admin'
    const editorBlocked = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
        body: csrfForm,
      })
    );
    expect(editorBlocked.status).toBe(403);

    // Oversized upload (> 1 MB) -> 413 + media.upload.rejected
    const bigForm = new FormData();
    bigForm.set(
      'file',
      new File([new Uint8Array(1024 * 1024 + 64).fill(0xff)], 'huge.jpg', { type: 'image/jpeg' })
    );
    const bigRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: 'http://localhost' },
        body: bigForm,
      })
    );
    expect(bigRes.status).toBe(413);

    // Verify #31 media.upload.rejected events captured
    const uploadRejectedEvents = securityEvents.filter((e) => e.type === 'media.upload.rejected');
    expect(uploadRejectedEvents.map((e) => e.reason)).toEqual([
      'magic_bytes_mismatch',
      'unsupported_media_type',
      'file_too_large',
    ]);

    // Validation edge cases on multipart fields
    const badSideForm = new FormData();
    badSideForm.set('file', new File([buildTestPngWithExif(16, 16, 'x')], 'x.png', { type: 'image/png' }));
    badSideForm.set('card_side', 'invalid_side');
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
            body: badSideForm,
          })
        )
      ).status
    ).toBe(400);

    const badCoverForm = new FormData();
    badCoverForm.set('file', new File([buildTestPngWithExif(16, 16, 'x')], 'x.png', { type: 'image/png' }));
    badCoverForm.set('set_cover', 'maybe');
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
            body: badCoverForm,
          })
        )
      ).status
    ).toBe(400);

    const badSortForm = new FormData();
    badSortForm.set('file', new File([buildTestPngWithExif(16, 16, 'x')], 'x.png', { type: 'image/png' }));
    badSortForm.set('sort_order', '9999');
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
            body: badSortForm,
          })
        )
      ).status
    ).toBe(400);

    const longCaptionForm = new FormData();
    longCaptionForm.set(
      'file',
      new File([buildTestPngWithExif(16, 16, 'x')], 'x.png', { type: 'image/png' })
    );
    longCaptionForm.set('caption', 'a'.repeat(245));
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
            body: longCaptionForm,
          })
        )
      ).status
    ).toBe(400);

    // Upload 1 valid photo then hit max_photos_per_recipe=1 on 2nd upload
    const okForm = new FormData();
    okForm.set('file', new File([buildTestPngWithExif(16, 16, 'x')], 'ok.png', { type: 'image/png' }));
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
            body: okForm,
          })
        )
      ).status
    ).toBe(201);

    const secondMaxRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: 'http://localhost' },
        body: okForm,
      })
    );
    expect(secondMaxRes.status).toBe(400);

    // 404 edge cases for missing recipe/photo on GET/POST/PATCH/DELETE
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/photos/missing', {
            headers: { cookie: adminCookie },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/missing-recipe/photos/pho_x', {
            method: 'DELETE',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos/missing-photo`, {
            method: 'PATCH',
            headers: {
              cookie: adminCookie,
              origin: 'http://localhost',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ caption: 'nope' }),
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${recipe.slug}/photos/missing-photo`, {
            method: 'DELETE',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/unknown-action', {
            method: 'POST',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/unknown-action', {
            method: 'PATCH',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/unknown-action', {
            method: 'DELETE',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
          })
        )
      ).status
    ).toBe(404);
  });
});

describe('createRecipesServerPlugin (Issue #49 structured recipe CRUD, optimistic concurrency, RBAC, and privacy)', () => {
  it('creates, updates via PATCH and PUT with optimistic locking, rejects stale 409 conflicts, and soft-deletes with zero email leaks', async () => {
    const { ports, server, securityEvents, cookieForUser, cookieForInvite } = await createTestHarness();
    const editorCookie = await cookieForUser('editor@archive.example.test', 'editor');
    const adminCookie = await cookieForUser('admin@archive.example.test', 'admin');
    const inviteCookie = await cookieForInvite();

    // Add a second editor so we can verify owner-only delete protection
    await ports.repository.upsertUser({
      email: 'other-editor@archive.example.test',
      display_name: 'Jonah Baker',
      role: 'editor',
      added_by: 'admin@archive.example.test',
      added_at: ports.clock.nowIso(),
      last_login_at: null,
    });
    const otherEditorCookie = await cookieForUser('other-editor@archive.example.test', 'editor');

    // Catalog reports can_create accurately by role
    const catalogEditor = (await (
      await server.fetch(
        new Request('http://localhost/api/plugins/recipes', { headers: { cookie: editorCookie } })
      )
    ).json()) as { permissions: { can_create: boolean } };
    expect(catalogEditor.permissions.can_create).toBe(true);

    const catalogInvite = (await (
      await server.fetch(
        new Request('http://localhost/api/plugins/recipes', { headers: { cookie: inviteCookie } })
      )
    ).json()) as { permissions: { can_create: boolean } };
    expect(catalogInvite.permissions.can_create).toBe(false);

    // CSRF origin mismatch is rejected before mutation
    const csrfRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: editorCookie,
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Blocked Cross Origin Pie' }),
      })
    );
    expect(csrfRes.status).toBe(403);

    // Invite viewers and agent tokens cannot create recipes (human-only RBAC)
    const inviteCreateRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: inviteCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Invite Viewer Dish' }),
      })
    );
    expect(inviteCreateRes.status).toBe(403);

    const agentBearer = 'kl_agent_recipe_crud_test';
    await ports.repository.createAgentToken({
      token_id: 'tok_agent_recipe_crud',
      token_hash: await sha256Hex(agentBearer),
      label: 'Recipe Sync Bot',
      scope: 'write_batch',
      created_by: 'admin@archive.example.test',
      created_at: ports.clock.nowIso(),
      revoked_at: null,
    });

    const agentCreateRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${agentBearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Bot Dish' }),
      })
    );
    expect(agentCreateRes.status).toBe(403);
    expect(
      securityEvents.some(
        (ev) =>
          ev.type === 'auth.write.forbidden' && ev.reason === 'member_required' && ev.actorKind === 'agent'
      )
    ).toBe(true);

    // Living-person attribution is rejected with 422 PRIVACY_VIOLATION
    const livingCreateRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Private Living Recipe',
          attributed_person_id: 'p_living',
        }),
      })
    );
    expect(livingCreateRes.status).toBe(422);
    const livingBody = (await livingCreateRes.json()) as { error: { code: string } };
    expect(livingBody.error.code).toBe('PRIVACY_VIOLATION');

    // Unknown ancestor ID is rejected with 400 INVALID_ANCESTOR_REFERENCE
    const missingAncestorRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Unknown Ancestor Soup',
          attributed_person_id: 'p_nonexistent',
        }),
      })
    );
    expect(missingAncestorRes.status).toBe(400);
    const missingAncestorBody = (await missingAncestorRes.json()) as { error: { code: string } };
    expect(missingAncestorBody.error.code).toBe('INVALID_ANCESTOR_REFERENCE');

    // Invalid payload fails Zod validation with 400 VALIDATION_ERROR
    const invalidRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'X' }),
      })
    );
    expect(invalidRes.status).toBe(400);

    // Editor creates structured recipe attributed to deceased ancestor
    const createPayload = {
      title: 'Cardamom Farmhouse Rolls',
      summary: 'Soft winter yeast rolls.',
      story_md: 'Baked every December.\n\n- Served warm.',
      ingredients: [
        { id: 'ing_1', quantity: '2', unit: 'cups', item: 'flour', note: 'sifted', group: 'Dry' },
        { id: 'ing_2', quantity: '1', unit: 'tsp', item: 'cardamom', note: '', group: 'Spices' },
      ],
      steps: [
        { id: 'stp_1', instruction: 'Bloom yeast in warm milk.', note: '110F' },
        { id: 'stp_2', instruction: 'Bake 18 minutes at 375F.', note: '' },
      ],
      prep_minutes: 30,
      cook_minutes: 18,
      servings: '12 rolls',
      course: 'bread',
      tags: ['Holiday', 'Baking', 'holiday'],
      provenance_note: 'Copied from the 1948 kitchen notebook.',
      source_era: '1940s',
      attributed_person_id: 'p_ada',
    };
    const createRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createPayload),
      })
    );
    expect(createRes.status).toBe(201);
    const createText = await createRes.text();
    expect(createText).not.toContain('editor@archive.example.test');
    const created = JSON.parse(createText) as {
      recipe: {
        id: string;
        slug: string;
        version: number;
        tags: string[];
        attributed_person: { id: string; full_name: string } | null;
      };
      permissions: { can_edit: boolean; can_delete: boolean };
    };
    expect(created.recipe.slug).toBe('cardamom-farmhouse-rolls');
    expect(created.recipe.version).toBe(1);
    expect(created.recipe.tags).toEqual(['holiday', 'baking']);
    expect(created.recipe.attributed_person).toEqual({
      id: 'p_ada',
      slug: 'ada-lovelace',
      full_name: 'Ada Lovelace',
    });
    expect(created.permissions.can_edit).toBe(true);
    expect(created.permissions.can_delete).toBe(true);

    // Duplicate explicit slug fails with 409 RECIPE_SLUG_CONFLICT
    const dupSlugRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Another Roll', slug: 'cardamom-farmhouse-rolls' }),
      })
    );
    expect(dupSlugRes.status).toBe(409);

    // Create a second recipe to test slug collision on update
    const secondRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Winter Cider', slug: 'winter-cider', course: 'beverage' }),
      })
    );
    expect(secondRes.status).toBe(201);

    // PATCH update with matching expected_version succeeds and bumps version to 2
    const patchRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${created.recipe.slug}`, {
        method: 'PATCH',
        headers: {
          cookie: adminCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...createPayload,
          title: 'Spiced Cardamom Farmhouse Rolls',
          expected_version: 1,
        }),
      })
    );
    expect(patchRes.status).toBe(200);
    const patchText = await patchRes.text();
    expect(patchText).not.toContain('admin@archive.example.test');
    const patched = JSON.parse(patchText) as {
      recipe: { version: number; title: string; updated_by_name: string };
    };
    expect(patched.recipe.version).toBe(2);
    expect(patched.recipe.title).toBe('Spiced Cardamom Farmhouse Rolls');
    expect(patched.recipe.updated_by_name).toBe('Archive Steward');

    // Stale PATCH with expected_version: 1 returns 409 RECIPE_VERSION_CONFLICT with current server recipe & zero emails
    const staleRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${created.recipe.slug}`, {
        method: 'PATCH',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...createPayload,
          title: 'Stale Overwrite Attempt',
          expected_version: 1,
        }),
      })
    );
    expect(staleRes.status).toBe(409);
    const staleText = await staleRes.text();
    expect(staleText).not.toContain('admin@archive.example.test');
    expect(staleText).not.toContain('editor@archive.example.test');
    const staleBody = JSON.parse(staleText) as {
      error: {
        code: string;
        details: {
          expected_version: number;
          server_version: number;
          server_updated_at: string;
          server_updated_by_name: string;
          server_recipe: { title: string; version: number };
        };
      };
    };
    expect(staleBody.error.code).toBe('RECIPE_VERSION_CONFLICT');
    expect(staleBody.error.details.expected_version).toBe(1);
    expect(staleBody.error.details.server_version).toBe(2);
    expect(staleBody.error.details.server_updated_by_name).toBe('Archive Steward');
    expect(staleBody.error.details.server_recipe.title).toBe('Spiced Cardamom Farmhouse Rolls');

    // PUT alias also updates cleanly when given current expected_version: 2
    const putRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${created.recipe.id}`, {
        method: 'PUT',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...createPayload,
          title: 'Spiced Cardamom Rolls (Revised)',
          expected_version: 2,
        }),
      })
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { recipe: { version: number; title: string } };
    expect(putBody.recipe.version).toBe(3);
    expect(putBody.recipe.title).toBe('Spiced Cardamom Rolls (Revised)');

    // PUT on unknown nested path returns 404
    const badPutRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes/a/b/c', {
        method: 'PUT',
        headers: { cookie: adminCookie, origin: 'http://localhost' },
      })
    );
    expect(badPutRes.status).toBe(404);

    // Slug collision on PATCH returns 409 RECIPE_SLUG_CONFLICT
    const slugCollisionRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${created.recipe.id}`, {
        method: 'PATCH',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...createPayload,
          slug: 'winter-cider',
          expected_version: 3,
        }),
      })
    );
    expect(slugCollisionRes.status).toBe(409);

    // Admin-only create_edit_min_role setting blocks editor writes with 403 + security event
    const saveSettingsRes = await server.fetch(
      new Request(`http://localhost/api/admin/plugin-settings/${RECIPES_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            create_edit_min_role: 'admin',
            upload_min_role: 'editor',
            star_min_role: 'editor',
            comment_min_role: 'editor',
            max_photo_mb: 10,
            max_photos_per_recipe: 12,
            show_home_widget: true,
          },
        }),
      })
    );
    expect(saveSettingsRes.status).toBe(200);

    const editorBlockedRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes', {
        method: 'POST',
        headers: {
          cookie: editorCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Blocked While Admin Only' }),
      })
    );
    expect(editorBlockedRes.status).toBe(403);
    expect(
      securityEvents.some((ev) => ev.type === 'auth.write.forbidden' && ev.reason === 'insufficient_role')
    ).toBe(true);

    // Non-owner editor cannot delete another member's recipe (403 + not_owner event)
    const nonOwnerDelRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${created.recipe.slug}`, {
        method: 'DELETE',
        headers: { cookie: otherEditorCookie, origin: 'http://localhost' },
      })
    );
    expect(nonOwnerDelRes.status).toBe(403);
    expect(securityEvents.some((ev) => ev.type === 'auth.write.forbidden' && ev.reason === 'not_owner')).toBe(
      true
    );

    // Agent token cannot delete recipes
    const agentDelRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${created.recipe.slug}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${agentBearer}` },
      })
    );
    expect(agentDelRes.status).toBe(403);

    // Original creator CAN soft-delete their own recipe
    const ownerDelRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${created.recipe.slug}`, {
        method: 'DELETE',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
      })
    );
    expect(ownerDelRes.status).toBe(204);

    // Deleted recipe returns 404 on subsequent GET and DELETE
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${created.recipe.slug}`, {
            headers: { cookie: adminCookie },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request(`http://localhost/api/plugins/recipes/${created.recipe.slug}`, {
            method: 'DELETE',
            headers: { cookie: adminCookie, origin: 'http://localhost' },
          })
        )
      ).status
    ).toBe(404);
  });
});

describe('createRecipesServerPlugin (Issue #50 starring, favorites, RBAC, and sort parity)', () => {
  it('supports idempotent POST/DELETE star endpoints, aggregate counts without voter leaks, favorites filtering, and most_starred sort', async () => {
    const { ports, recipesRepo, server, securityEvents, cookieForUser, cookieForInvite } =
      await createTestHarness();
    const adminCookie = await cookieForUser('admin@archive.example.test', 'admin');
    const editorCookie = await cookieForUser('editor@archive.example.test', 'editor');
    const inviteCookie = await cookieForInvite();

    const r1 = await recipesRepo.createRecipe({
      id: 'rec_star_1',
      data: CreateRecipeInputSchema.parse({
        title: 'Buckwheat Griddle Cakes',
        course: 'breakfast',
        attributed_person_id: 'p_ada',
      }),
      actor: { id: 'editor@archive.example.test', name: 'Clara Baker' },
      nowIso: '2026-11-27T09:00:00.000Z',
    });
    const r2 = await recipesRepo.createRecipe({
      id: 'rec_star_2',
      data: CreateRecipeInputSchema.parse({
        title: 'Spiced Pear Preserves',
        course: 'preserve',
        attributed_person_id: 'p_ada',
      }),
      actor: { id: 'admin@archive.example.test', name: 'Archive Steward' },
      nowIso: '2026-11-27T10:00:00.000Z',
    });

    // Update r1 so its updated_at is later than r2 for most_starred tie-break verification
    await recipesRepo.updateRecipe({
      id: r1.id,
      data: {
        ...CreateRecipeInputSchema.parse({
          title: 'Buckwheat Griddle Cakes',
          course: 'breakfast',
          attributed_person_id: 'p_ada',
        }),
        expected_version: 1,
      },
      actor: { id: 'editor@archive.example.test', name: 'Clara Baker' },
      nowIso: '2026-11-27T11:30:00.000Z',
    });

    // Anonymous POST/DELETE is rejected with 401 and emits #31 auth.write.forbidden telemetry
    const anonStarRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'POST',
        headers: { origin: 'http://localhost' },
      })
    );
    expect(anonStarRes.status).toBe(401);
    expect(
      securityEvents.some(
        (ev) =>
          ev.type === 'auth.write.forbidden' &&
          ev.reason === 'unauthenticated' &&
          ev.actorKind === 'anonymous'
      )
    ).toBe(true);

    // CSRF origin mismatch is rejected with 403 and emits csrf.rejected telemetry
    const csrfRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'https://evil.example' },
      })
    );
    expect(csrfRes.status).toBe(403);
    expect(securityEvents.some((ev) => ev.type === 'csrf.rejected')).toBe(true);

    // API agent token is rejected (human-only) with 403 + auth.write.forbidden telemetry
    const agentBearer = 'kl_agent_star_blocked_test';
    await ports.repository.createAgentToken({
      token_id: 'tok_agent_star',
      token_hash: await sha256Hex(agentBearer),
      label: 'Star Bot',
      scope: 'write_batch',
      created_by: 'admin@archive.example.test',
      created_at: ports.clock.nowIso(),
      revoked_at: null,
    });
    const agentStarRes = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentBearer}` },
      })
    );
    expect(agentStarRes.status).toBe(403);
    expect(
      securityEvents.some(
        (ev) =>
          ev.type === 'auth.write.forbidden' && ev.reason === 'member_required' && ev.actorKind === 'agent'
      )
    ).toBe(true);

    // Invite viewer is blocked under default star_min_role='editor' and sees can_star: false
    const catalogInviteDefault = (await (
      await server.fetch(
        new Request('http://localhost/api/plugins/recipes', { headers: { cookie: inviteCookie } })
      )
    ).json()) as { permissions: { can_create: boolean; can_star: boolean } };
    expect(catalogInviteDefault.permissions).toEqual({ can_create: false, can_star: false });

    const inviteStarBlocked = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'POST',
        headers: { cookie: inviteCookie, origin: 'http://localhost' },
      })
    );
    expect(inviteStarBlocked.status).toBe(403);
    expect(
      securityEvents.some(
        (ev) =>
          ev.type === 'auth.write.forbidden' &&
          ev.reason === 'invite_read_only' &&
          ev.actorKind === 'invite_viewer'
      )
    ).toBe(true);

    // Editor stars r1 twice (strictly idempotent) and verifies zero voter leaks in JSON
    const starOnce = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
      })
    );
    expect(starOnce.status).toBe(200);
    const starOnceText = await starOnce.text();
    expect(starOnceText).not.toContain('editor@archive.example.test');
    expect(starOnceText).not.toContain('usr_');
    expect(JSON.parse(starOnceText)).toEqual({
      recipe_id: r1.id,
      star_count: 1,
      viewer_has_starred: true,
    });

    const starTwice = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.id}/star`, {
        method: 'POST',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
      })
    );
    expect(starTwice.status).toBe(200);
    expect(await starTwice.json()).toEqual({
      recipe_id: r1.id,
      star_count: 1,
      viewer_has_starred: true,
    });

    // Admin also stars r2 -> both r1 and r2 have 1 star, r1 has newer updated_at so sorts first under most_starred
    const adminStarR2 = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r2.slug}/star`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: 'http://localhost' },
      })
    );
    expect(adminStarR2.status).toBe(200);
    expect(await adminStarR2.json()).toEqual({
      recipe_id: r2.id,
      star_count: 1,
      viewer_has_starred: true,
    });

    // Catalog sort=most_starred orders by star_count DESC, updated_at DESC and returns caller-scoped viewer_has_starred + permissions.can_star
    const sortedRes = await server.fetch(
      new Request('http://localhost/api/plugins/recipes?sort=most_starred', {
        headers: { cookie: editorCookie },
      })
    );
    expect(sortedRes.status).toBe(200);
    const sortedText = await sortedRes.text();
    expect(sortedText).not.toContain('editor@archive.example.test');
    expect(sortedText).not.toContain('admin@archive.example.test');
    const sortedJson = JSON.parse(sortedText) as {
      recipes: Array<{ id: string; star_count: number; viewer_has_starred: boolean }>;
      permissions: { can_create: boolean; can_star: boolean };
    };
    expect(sortedJson.permissions).toEqual({ can_create: true, can_star: true });
    expect(sortedJson.recipes.map((r) => [r.id, r.star_count, r.viewer_has_starred])).toEqual([
      [r1.id, 1, true],
      [r2.id, 1, false],
    ]);

    // favorites=true returns only the caller's starred recipes
    const editorFavs = (await (
      await server.fetch(
        new Request('http://localhost/api/plugins/recipes?favorites=true', {
          headers: { cookie: editorCookie },
        })
      )
    ).json()) as { recipes: Array<{ id: string }>; total: number };
    expect(editorFavs.total).toBe(1);
    expect(editorFavs.recipes.map((r) => r.id)).toEqual([r1.id]);

    const adminFavs = (await (
      await server.fetch(
        new Request('http://localhost/api/plugins/recipes?favorites=1', {
          headers: { cookie: adminCookie },
        })
      )
    ).json()) as { recipes: Array<{ id: string }>; total: number };
    expect(adminFavs.total).toBe(1);
    expect(adminFavs.recipes.map((r) => r.id)).toEqual([r2.id]);

    // Person endpoint includes aggregate star_count, caller-scoped viewer_has_starred, and permissions.can_star
    const byPersonJson = (await (
      await server.fetch(
        new Request('http://localhost/api/plugins/recipes/by-person/p_ada', {
          headers: { cookie: editorCookie },
        })
      )
    ).json()) as {
      recipes: Array<{ id: string; star_count: number; viewer_has_starred: boolean }>;
      permissions: { can_star: boolean };
    };
    expect(byPersonJson.permissions).toEqual({ can_star: true });
    expect(byPersonJson.recipes.find((r) => r.id === r1.id)?.viewer_has_starred).toBe(true);
    expect(byPersonJson.recipes.find((r) => r.id === r2.id)?.viewer_has_starred).toBe(false);

    // Admin enables star_min_role='viewer' via #44 settings -> invite_viewer can now star & unstar
    const enableInviteStar = await server.fetch(
      new Request(`http://localhost/api/admin/plugin-settings/${RECIPES_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            create_edit_min_role: 'editor',
            upload_min_role: 'editor',
            star_min_role: 'viewer',
            comment_min_role: 'editor',
            max_photo_mb: 10,
            max_photos_per_recipe: 12,
            show_home_widget: true,
          },
        }),
      })
    );
    expect(enableInviteStar.status).toBe(200);

    const inviteStarOk = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'POST',
        headers: { cookie: inviteCookie, origin: 'http://localhost' },
      })
    );
    expect(inviteStarOk.status).toBe(200);
    expect(await inviteStarOk.json()).toEqual({
      recipe_id: r1.id,
      star_count: 2,
      viewer_has_starred: true,
    });

    const inviteUnstarOk = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'DELETE',
        headers: { cookie: inviteCookie, origin: 'http://localhost' },
      })
    );
    expect(inviteUnstarOk.status).toBe(200);
    expect(await inviteUnstarOk.json()).toEqual({
      recipe_id: r1.id,
      star_count: 1,
      viewer_has_starred: false,
    });

    // Idempotent DELETE twice
    const editorUnstar1 = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'DELETE',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
      })
    );
    expect(editorUnstar1.status).toBe(200);
    expect(await editorUnstar1.json()).toEqual({
      recipe_id: r1.id,
      star_count: 0,
      viewer_has_starred: false,
    });

    const editorUnstar2 = await server.fetch(
      new Request(`http://localhost/api/plugins/recipes/${r1.slug}/star`, {
        method: 'DELETE',
        headers: { cookie: editorCookie, origin: 'http://localhost' },
      })
    );
    expect(editorUnstar2.status).toBe(200);
    expect(await editorUnstar2.json()).toEqual({
      recipe_id: r1.id,
      star_count: 0,
      viewer_has_starred: false,
    });

    // Missing recipe returns 404 on POST and DELETE star
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/nonexistent-recipe/star', {
            method: 'POST',
            headers: { cookie: editorCookie, origin: 'http://localhost' },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request('http://localhost/api/plugins/recipes/nonexistent-recipe/star', {
            method: 'DELETE',
            headers: { cookie: editorCookie, origin: 'http://localhost' },
          })
        )
      ).status
    ).toBe(404);
  });
});
