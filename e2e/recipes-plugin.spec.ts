import { CreateRecipeInputSchema } from '@kinloom/server';
import { expect, test } from '@playwright/test';
import { startLiveWikiTestServer } from './helpers/wikiTestServer.js';

const STATIC_DEMO_ORIGIN = 'http://127.0.0.1:4173';

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
