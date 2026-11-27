import {
  CreateRecipeInputSchema,
  computeCrc32,
  getSessionCookieName,
  signSessionToken,
} from '@kinloom/server';
import { expect, test } from '@playwright/test';
import { startLiveWikiTestServer } from './helpers/wikiTestServer.js';

const STATIC_DEMO_ORIGIN = 'http://127.0.0.1:4173';
const E2E_SESSION_SECRET = 'kinloom-e2e-test-session-secret-0123456789abcdef';

function buildE2ePngWithExif(secretExif: string): Buffer {
  const enc = new TextEncoder();
  const makeChunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = new Uint8Array(4 + data.byteLength);
    body.set(enc.encode(type), 0);
    body.set(data, 4);
    const out = new Uint8Array(12 + data.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.byteLength, false);
    out.set(body, 4);
    dv.setUint32(8 + data.byteLength, computeCrc32(body), false);
    return out;
  };
  // Valid 1x1 RGB PNG with injected eXIf GPS chunk
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = new Uint8Array([
    0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0,
  ]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdr),
    makeChunk('eXIf', enc.encode(secretExif)),
    makeChunk('IDAT', idat),
    makeChunk('IEND', new Uint8Array(0)),
  ];
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

test('default unconfigured archives render zero Recipes nav links, slots, or API routes', async ({
  page,
}) => {
  await page.goto(`${STATIC_DEMO_ORIGIN}/`);
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Recipes' })
  ).toHaveCount(0);
  await expect(page.locator('[data-slot="indexWidgets"]')).toHaveCount(0);

  const defaultWiki = await startLiveWikiTestServer();
  try {
    await page.goto(`${defaultWiki.baseUrl}/api/auth/invite/${defaultWiki.inviteToken}`);
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Recipes' })
    ).toHaveCount(0);
    const res = await page.request.get(`${defaultWiki.baseUrl}/api/plugins/recipes`);
    expect(res.status()).toBe(404);
  } finally {
    await defaultWiki.close();
  }
});

test('opt-in Family Recipe Box browse, filter, detail, PersonPage slot, IndexPage shelf, and mobile layout', async ({
  page,
}) => {
  const wiki = await startLiveWikiTestServer({ enableRecipesPlugin: true });
  try {
    expect(wiki.recipesRepo).not.toBeNull();
    const repo = wiki.recipesRepo!;

    await repo.createRecipe({
      id: 'rec_e2e_1',
      data: CreateRecipeInputSchema.parse({
        title: 'Prairie Cornmeal Johnnycakes',
        summary: 'Griddle-baked cornmeal cakes handed down from 1840s Illinois.',
        story_md: 'Served hot with sorghum syrup on crisp autumn mornings.',
        ingredients: [
          { id: 'i1', quantity: '1', unit: 'cup', item: 'stone-ground cornmeal', note: '', group: 'Dry' },
          { id: 'i2', quantity: '1', unit: 'cup', item: 'boiling water', note: '', group: 'Wet' },
        ],
        steps: [
          { id: 's1', instruction: 'Scald the cornmeal with boiling water and salt.', note: 'Stir smooth.' },
          { id: 's2', instruction: 'Fry spoonfuls on a hot cast-iron griddle until golden.', note: '' },
        ],
        prep_minutes: 10,
        cook_minutes: 15,
        servings: '8 cakes',
        course: 'breakfast',
        tags: ['heirloom', 'griddle'],
        provenance_note: 'Recorded in Springfield family notebook.',
        source_era: '1840s',
        attributed_person_id: 'p_abraham_lincoln_1809',
      }),
      actor: { id: wiki.adminEmail, name: 'Archive Steward' },
      nowIso: '2026-11-24T12:00:00.000Z',
    });

    await repo.createRecipe({
      id: 'rec_e2e_2',
      data: CreateRecipeInputSchema.parse({
        title: 'Spiced Gingerbread Loaf',
        summary: 'Dark molasses gingerbread baked for winter gatherings.',
        course: 'dessert',
        tags: ['winter', 'heirloom'],
        source_era: '1860s',
      }),
      actor: { id: wiki.adminEmail, name: 'Archive Steward' },
      nowIso: '2026-11-24T12:10:00.000Z',
    });

    await page.goto(`${wiki.baseUrl}/api/auth/invite/${wiki.inviteToken}`);

    // 1. IndexPage renders IndexRecipesWidget shelf and Recipes nav pill
    const primaryNav = page.getByRole('navigation', { name: 'Primary' });
    const recipesLink = primaryNav.getByRole('link', { name: 'Recipes' });
    await expect(recipesLink).toBeVisible();
    await expect(page.locator('[data-slot="indexWidgets"]')).toContainText('Prairie Cornmeal Johnnycakes');

    // 2. PersonPage renders personRelated Heirloom Recipes panel for deceased Abraham Lincoln
    await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);
    await expect(page.getByRole('heading', { name: 'Heirloom Recipes' })).toBeVisible();
    await expect(page.locator('[data-slot="personRelated"]')).toContainText('Prairie Cornmeal Johnnycakes');

    // 3. Click Recipes nav link -> browse & filter catalog
    await recipesLink.click();
    await expect(page).toHaveURL(/\/recipes$/);
    await expect(page.getByRole('heading', { name: 'Family Recipe Box', level: 1 })).toBeVisible();
    await expect(recipesLink).toHaveAttribute('aria-current', 'page');

    await page.getByLabel('Course').selectOption('breakfast');
    await expect(page.getByRole('link', { name: 'Prairie Cornmeal Johnnycakes' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Spiced Gingerbread Loaf' })).toHaveCount(0);

    // 4. Open recipe detail -> nav pill remains active via navMatchPrefix
    await page.getByRole('link', { name: 'Prairie Cornmeal Johnnycakes' }).click();
    await expect(page).toHaveURL(/\/recipes\/prairie-cornmeal-johnnycakes$/);
    await expect(recipesLink).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Prairie Cornmeal Johnnycakes', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /Attributed to Abraham Lincoln/ })).toBeVisible();
    await expect(page.getByText('1 cup stone-ground cornmeal')).toBeVisible();
    await expect(page.getByText('Scald the cornmeal with boiling water and salt.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print Recipe Card' })).toBeVisible();

    // 5. Check mobile viewport (375x812): zero horizontal overflow & mobile menu reaches Recipes
    await page.setViewportSize({ width: 375, height: 812 });
    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(hasOverflow).toBe(false);

    await page.getByRole('button', { name: 'Archive menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Recipes' })).toBeVisible();
  } finally {
    await wiki.close();
  }
});

test('recipe card photo upload strips EXIF, renders archival zoom lightbox, and supports photo delete', async ({
  page,
}) => {
  const wiki = await startLiveWikiTestServer({ enableRecipesPlugin: true });
  try {
    const repo = wiki.recipesRepo!;
    await repo.createRecipe({
      id: 'rec_e2e_photos',
      data: CreateRecipeInputSchema.parse({
        title: 'Heirloom Rye Loaf',
        summary: 'Caraway rye bread from the 1880s.',
        course: 'bread',
      }),
      actor: { id: wiki.adminEmail, name: 'Archive Steward' },
      nowIso: '2026-11-24T12:00:00.000Z',
    });

    const token = await signSessionToken({
      secret: E2E_SESSION_SECRET,
      clock: wiki.ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: wiki.adminEmail,
        display_name: 'Archive Steward',
        role: 'admin',
      },
    });
    const url = new URL(wiki.baseUrl);
    await page.context().addCookies([
      {
        name: getSessionCookieName(false),
        value: token,
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await page.goto(`${wiki.baseUrl}/recipes/heirloom-rye-loaf`);
    await expect(page.getByRole('heading', { name: 'Heirloom Rye Loaf', level: 1 })).toBeVisible();

    await page.getByLabel('Photo Caption (Optional)').fill('Front of handwritten rye card');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'rye-card-front.png',
      mimeType: 'image/png',
      buffer: buildE2ePngWithExif('E2E_EXIF_GPS_SECRET_39_78'),
    });

    await expect(page.getByText('Recipe card photo uploaded.')).toBeVisible();
    const cardButton = page.getByRole('button', { name: /Front of handwritten rye card/ });
    await expect(cardButton).toBeVisible();

    // Verify served image bytes stripped EXIF GPS secret
    const imgSrc = await cardButton.locator('img').getAttribute('src');
    expect(imgSrc).toMatch(/^\/api\/plugins\/recipes\/photos\/pho_/);
    const imgRes = await page.request.get(`${wiki.baseUrl}${imgSrc}`);
    expect(imgRes.status()).toBe(200);
    expect(imgRes.headers()['x-content-type-options']).toBe('nosniff');
    expect(imgRes.headers()['content-disposition']).toContain('inline');
    const servedText = (await imgRes.body()).toString('latin1');
    expect(servedText).not.toContain('E2E_EXIF_GPS_SECRET_39_78');

    // Open archival lightbox, zoom in to 150%, then dismiss with Escape
    await cardButton.click();
    const lightbox = page.locator('dialog[open]');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByText('100%')).toBeVisible();
    await lightbox.getByRole('button', { name: 'Zoom in' }).click();
    await expect(lightbox.getByText('150%')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();

    // Delete photo via two-step confirm
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm Delete', exact: true }).click();
    await expect(page.getByText('Recipe card photo deleted.')).toBeVisible();
    await expect(cardButton).toHaveCount(0);
  } finally {
    await wiki.close();
  }
});
