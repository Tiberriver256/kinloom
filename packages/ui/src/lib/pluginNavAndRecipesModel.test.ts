import type { ArchiveCapabilities, ArchiveSessionState } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  isPluginNavRouteActive,
  isPluginNavRouteVisible,
  selectVisiblePluginNavRoutes,
} from './pluginNav.js';
import {
  addDraftTag,
  buildRecipesListQueryString,
  countActiveRecipeComments,
  createEmptyRecipeDraft,
  extractRecipeApiFieldErrors,
  filterStaticRecipes,
  formatDeletedCommentTombstone,
  formatRecipeCourseLabel,
  formatRecipeDuration,
  formatRecipeIngredientLine,
  formatTotalRecipeDuration,
  groupRecipeCommentThreads,
  groupRecipeIngredients,
  isRecipeDraftDirty,
  moveDraftListItem,
  normalizeDraftTagInput,
  parseUiCreateRecipeCommentResponse,
  parseUiRecipeCommentsListResponse,
  parseUiRecipeDetailResponse,
  parseUiRecipeListResponse,
  parseUiRecipeMutationResponse,
  parseUiRecipesByPersonResponse,
  parseUiRecipeVersionConflict,
  parseUiUpdateRecipeCommentResponse,
  recipeDetailToEditorDraft,
  removeDraftTag,
  type UiRecipeComment,
  type UiRecipeDetail,
  validateRecipeCommentBody,
  validateRecipeDraft,
} from './recipesModel.js';

const NO_CAPS: ArchiveCapabilities = {
  canEdit: false,
  canUploadMedia: false,
  hasRevisionHistory: false,
  hasTalk: false,
  canManageSite: false,
};

const EDITOR_CAPS: ArchiveCapabilities = {
  ...NO_CAPS,
  canEdit: true,
};

const ADMIN_CAPS: ArchiveCapabilities = {
  ...EDITOR_CAPS,
  canManageSite: true,
};

const ANON_SESSION: ArchiveSessionState = {
  authenticated: false,
  principal_kind: 'anonymous',
};

const INVITE_SESSION: ArchiveSessionState = {
  authenticated: false,
  principal_kind: 'invite_viewer',
  role: 'viewer',
};

const EDITOR_SESSION: ArchiveSessionState = {
  authenticated: true,
  principal_kind: 'user',
  email: 'editor@archive.example.test',
  role: 'editor',
};

const ADMIN_SESSION: ArchiveSessionState = {
  authenticated: true,
  principal_kind: 'user',
  email: 'admin@archive.example.test',
  role: 'admin',
};

const SAMPLE_RECIPES: readonly UiRecipeDetail[] = [
  {
    id: 'rec_1',
    slug: 'honey-biscuits',
    title: 'Honey Biscuits',
    summary: 'Warm biscuits baked in cast iron.',
    story_md: 'Baked on Sundays.',
    ingredients: [
      { id: 'i1', quantity: '2', unit: 'cups', item: 'flour', note: 'sifted', group: 'Dry' },
      { id: 'i2', quantity: '1', unit: 'cup', item: 'buttermilk', note: '', group: 'Wet' },
      { id: 'i3', quantity: '', unit: '', item: 'pinch of salt', note: '', group: 'Dry' },
    ],
    steps: [{ id: 's1', instruction: 'Mix and bake.', note: '15 minutes' }],
    prep_minutes: 15,
    cook_minutes: 20,
    servings: '12 biscuits',
    course: 'bread',
    tags: ['heirloom', 'winter'],
    provenance_note: '1840 notebook',
    source_era: 'c. 1840',
    attributed_person_id: 'p_ada',
    attributed_person: { id: 'p_ada', slug: 'ada-lovelace', full_name: 'Ada Lovelace' },
    cover_photo_id: null,
    cover_photo_url: null,
    star_count: 5,
    comment_count: 2,
    viewer_has_starred: true,
    version: 1,
    created_by_name: 'Clara',
    updated_by_name: 'Clara',
    created_at: '2026-11-26T10:00:00.000Z',
    updated_at: '2026-11-26T10:00:00.000Z',
  },
  {
    id: 'rec_2',
    slug: 'apple-pie',
    title: 'Apple Pie',
    summary: 'Spiced autumn dessert.',
    story_md: '',
    ingredients: [],
    steps: [],
    prep_minutes: 30,
    cook_minutes: 45,
    servings: '8 slices',
    course: 'dessert',
    tags: ['autumn'],
    provenance_note: '',
    source_era: '1920s',
    attributed_person_id: null,
    attributed_person: null,
    cover_photo_id: null,
    cover_photo_url: null,
    star_count: 2,
    comment_count: 0,
    viewer_has_starred: false,
    version: 1,
    created_by_name: 'Clara',
    updated_by_name: 'Clara',
    created_at: '2026-11-27T10:00:00.000Z',
    updated_at: '2026-11-27T10:00:00.000Z',
  },
];

const DummyNavComponent = () => null;

describe('pluginNav pure helpers', () => {
  it('enforces navMinRole visibility across sessions and capabilities', () => {
    expect(isPluginNavRouteVisible(undefined, null, NO_CAPS)).toBe(true);
    expect(isPluginNavRouteVisible('public', ANON_SESSION, NO_CAPS)).toBe(true);

    expect(isPluginNavRouteVisible('viewer', null, NO_CAPS)).toBe(false);
    expect(isPluginNavRouteVisible('viewer', ANON_SESSION, NO_CAPS)).toBe(false);
    expect(isPluginNavRouteVisible('viewer', INVITE_SESSION, NO_CAPS)).toBe(true);
    expect(isPluginNavRouteVisible('viewer', EDITOR_SESSION, NO_CAPS)).toBe(true);

    expect(isPluginNavRouteVisible('editor', INVITE_SESSION, NO_CAPS)).toBe(false);
    expect(isPluginNavRouteVisible('editor', EDITOR_SESSION, NO_CAPS)).toBe(true);
    expect(isPluginNavRouteVisible('editor', null, EDITOR_CAPS)).toBe(true);

    expect(isPluginNavRouteVisible('admin', EDITOR_SESSION, EDITOR_CAPS)).toBe(false);
    expect(isPluginNavRouteVisible('admin', ADMIN_SESSION, NO_CAPS)).toBe(true);
    expect(isPluginNavRouteVisible('admin', null, ADMIN_CAPS)).toBe(true);
  });

  it('matches active plugin routes by exact path or navMatchPrefix boundary', () => {
    expect(isPluginNavRouteActive({ path: '/support' }, '/support')).toBe(true);
    expect(isPluginNavRouteActive({ path: '/support' }, '/support/')).toBe(true);
    expect(isPluginNavRouteActive({ path: '/support' }, '/support/extra')).toBe(false);

    expect(isPluginNavRouteActive({ path: '/recipes', navMatchPrefix: '/recipes' }, '/recipes')).toBe(true);
    expect(
      isPluginNavRouteActive({ path: '/recipes', navMatchPrefix: '/recipes' }, '/recipes/honey-biscuits')
    ).toBe(true);
    expect(isPluginNavRouteActive({ path: '/recipes', navMatchPrefix: '/recipes' }, '/recipes-other')).toBe(
      false
    );
    expect(isPluginNavRouteActive({ path: '/', navMatchPrefix: '/' }, '/')).toBe(true);
    expect(isPluginNavRouteActive({ path: '/', navMatchPrefix: '/' }, '/places')).toBe(false);
  });

  it('filters visible routes and sorts by navOrder while preserving ties', () => {
    const routes = [
      { path: '/z', navLabel: 'Zeta', navOrder: 10, component: DummyNavComponent },
      { path: '/hidden', component: DummyNavComponent },
      { path: '/b', navLabel: 'Beta', component: DummyNavComponent },
      { path: '/a', navLabel: 'Alpha', navOrder: -1, component: DummyNavComponent },
      { path: '/c', navLabel: 'Gamma', component: DummyNavComponent },
      { path: '/admin-only', navLabel: 'Ops', navMinRole: 'admin' as const, component: DummyNavComponent },
    ];
    const visibleForEditor = selectVisiblePluginNavRoutes(routes, EDITOR_SESSION, EDITOR_CAPS);
    expect(visibleForEditor.map((r) => r.navLabel)).toEqual(['Alpha', 'Beta', 'Gamma', 'Zeta']);

    const visibleForAdmin = selectVisiblePluginNavRoutes(routes, ADMIN_SESSION, ADMIN_CAPS);
    expect(visibleForAdmin.map((r) => r.navLabel)).toContain('Ops');
  });
});

describe('recipesModel pure helpers and parsers', () => {
  it('formats durations, course labels, ingredients, and query strings', () => {
    expect(formatRecipeCourseLabel('soup_salad')).toBe('Soup & Salad');
    expect(formatRecipeDuration(null)).toBeNull();
    expect(formatRecipeDuration(-5)).toBeNull();
    expect(formatRecipeDuration(0)).toBe('0 min');
    expect(formatRecipeDuration(45)).toBe('45 min');
    expect(formatRecipeDuration(60)).toBe('1 hr');
    expect(formatRecipeDuration(95)).toBe('1 hr 35 min');
    expect(formatTotalRecipeDuration(null, null)).toBeNull();
    expect(formatTotalRecipeDuration(15, 45)).toBe('1 hr');
    expect(formatTotalRecipeDuration(20, null)).toBe('20 min');

    const groups = groupRecipeIngredients(SAMPLE_RECIPES[0].ingredients);
    expect(groups).toHaveLength(2);
    expect(groups[0].group).toBe('Dry');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].group).toBe('Wet');

    expect(formatRecipeIngredientLine(SAMPLE_RECIPES[0].ingredients[0])).toBe('2 cups flour, sifted');
    expect(formatRecipeIngredientLine(SAMPLE_RECIPES[0].ingredients[2])).toBe('pinch of salt');

    expect(buildRecipesListQueryString({})).toBe('');
    expect(
      buildRecipesListQueryString({
        q: ' biscuits ',
        course: 'bread',
        tag: 'Winter',
        attributed_person_id: 'p_ada',
        favorites: true,
        sort: 'stars',
        limit: 12,
        offset: 24,
      })
    ).toBe(
      '?q=biscuits&course=bread&tag=winter&attributed_person_id=p_ada&favorites=1&sort=stars&limit=12&offset=24'
    );
  });

  it('filters, sorts, paginates static recipes and validates API response payloads', () => {
    const byStars = filterStaticRecipes(SAMPLE_RECIPES, { sort: 'stars' });
    expect(byStars.recipes.map((r) => r.id)).toEqual(['rec_1', 'rec_2']);
    expect(byStars.facets.courses).toEqual(['bread', 'dessert']);
    expect(byStars.facets.tags).toEqual(['autumn', 'heirloom', 'winter']);

    expect(filterStaticRecipes(SAMPLE_RECIPES, { sort: 'newest' }).recipes.map((r) => r.id)).toEqual([
      'rec_2',
      'rec_1',
    ]);
    expect(filterStaticRecipes(SAMPLE_RECIPES, { sort: 'alpha' }).recipes.map((r) => r.id)).toEqual([
      'rec_2',
      'rec_1',
    ]);
    expect(filterStaticRecipes(SAMPLE_RECIPES, { favorites: true }).recipes.map((r) => r.id)).toEqual([
      'rec_1',
    ]);
    expect(filterStaticRecipes(SAMPLE_RECIPES, { course: 'dessert' }).recipes.map((r) => r.id)).toEqual([
      'rec_2',
    ]);
    expect(filterStaticRecipes(SAMPLE_RECIPES, { tag: 'winter' }).recipes.map((r) => r.id)).toEqual([
      'rec_1',
    ]);
    expect(
      filterStaticRecipes(SAMPLE_RECIPES, { attributed_person_id: 'p_ada' }).recipes.map((r) => r.id)
    ).toEqual(['rec_1']);
    expect(filterStaticRecipes(SAMPLE_RECIPES, { q: '1840' }).recipes.map((r) => r.id)).toEqual(['rec_1']);

    expect(parseUiRecipeListResponse(byStars).total).toBe(2);
    expect(
      parseUiRecipeDetailResponse({
        recipe: SAMPLE_RECIPES[0],
        photos: [],
        viewer_has_starred: true,
        permissions: {
          can_edit: true,
          can_delete: true,
          can_upload: true,
          can_star: true,
          can_comment: true,
        },
      }).recipe.slug
    ).toBe('honey-biscuits');
    expect(
      parseUiRecipesByPersonResponse({
        person_id: 'p_ada',
        recipes: [SAMPLE_RECIPES[0]],
        total: 1,
      }).total
    ).toBe(1);
  });

  it('validates recipe editor drafts, reorders rows, manages tags, and parses mutation and conflict payloads', () => {
    const empty = createEmptyRecipeDraft();
    expect(isRecipeDraftDirty(empty, empty)).toBe(false);
    expect(isRecipeDraftDirty({ ...empty, title: 'Scones' }, empty)).toBe(true);

    const fromDetail = recipeDetailToEditorDraft(SAMPLE_RECIPES[0]);
    expect(fromDetail.title).toBe('Honey Biscuits');
    expect(fromDetail.prep_minutes).toBe('15');
    expect(fromDetail.ingredients).toHaveLength(3);
    expect(recipeDetailToEditorDraft(SAMPLE_RECIPES[1]).ingredients).toHaveLength(1);

    // Row reordering clamps out-of-bounds moves safely
    expect(moveDraftListItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveDraftListItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveDraftListItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveDraftListItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);

    // Tag normalization, deduplication, removal, and bounds
    expect(normalizeDraftTagInput('')).toMatchObject({ ok: false });
    expect(normalizeDraftTagInput('bad!tag')).toMatchObject({ ok: false });
    expect(normalizeDraftTagInput('#Winter Bread')).toEqual({ ok: true, tag: 'winter bread' });
    const added = addDraftTag(['winter'], '#Holiday');
    expect(added.tags).toEqual(['winter', 'holiday']);
    expect(addDraftTag(added.tags, 'holiday').tags).toEqual(['winter', 'holiday']);
    expect(addDraftTag(added.tags, '!!!').error).toBeDefined();
    const twenty = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    expect(addDraftTag(twenty, 'tag-21').error).toContain('20');
    expect(removeDraftTag(['winter', 'holiday'], 'winter')).toEqual(['holiday']);

    // Draft validation rejects invalid fields and normalizes valid drafts
    const invalid = validateRecipeDraft({
      ...empty,
      title: 'A',
      slug: 'Bad Slug!',
      prep_minutes: 'abc',
      cook_minutes: '99999',
      ingredients: [{ id: 'i1', quantity: '1', unit: 'cup', item: '', note: '', group: '' }],
      steps: [{ id: 's1', instruction: '', note: 'Missing instruction' }],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.fieldErrors.title).toBeDefined();
      expect(invalid.fieldErrors.slug).toBeDefined();
      expect(invalid.fieldErrors.prep_minutes).toBeDefined();
      expect(invalid.fieldErrors.cook_minutes).toBeDefined();
      expect(invalid.fieldErrors['ingredients.0.item']).toBeDefined();
      expect(invalid.fieldErrors['steps.0.instruction']).toBeDefined();
    }

    const valid = validateRecipeDraft({
      ...fromDetail,
      slug: 'honey-biscuits',
      prep_minutes: '15',
      cook_minutes: '',
      ingredients: [
        ...fromDetail.ingredients,
        { id: 'blank', quantity: '', unit: '', item: '', note: '', group: '' },
      ],
      steps: [...fromDetail.steps, { id: 'blank_s', instruction: '', note: '' }],
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.payload.prep_minutes).toBe(15);
      expect(valid.payload.cook_minutes).toBeNull();
      expect(valid.payload.ingredients).toHaveLength(3);
      expect(valid.payload.steps).toHaveLength(1);
    }

    // Mutation & 409 conflict detail parsers + API field error extraction
    expect(parseUiRecipeMutationResponse({ recipe: SAMPLE_RECIPES[0] }).recipe.id).toBe('rec_1');
    expect(parseUiRecipeVersionConflict({ nope: true })).toBeNull();
    expect(
      parseUiRecipeVersionConflict({
        expected_version: 1,
        server_version: 2,
        server_updated_at: '2026-11-27T12:00:00.000Z',
        server_updated_by_name: 'Archive Steward',
        server_recipe: SAMPLE_RECIPES[0],
      })?.server_version
    ).toBe(2);
    expect(
      extractRecipeApiFieldErrors([
        { path: 'title', message: 'Too short' },
        { path: 'title', message: 'Duplicate ignored' },
      ])
    ).toEqual({ title: 'Too short' });
    expect(extractRecipeApiFieldErrors('not-an-array')).toEqual({});
  });

  it('validates comment bodies, groups 2-level comment threads, formats tombstones, and parses comment payloads', () => {
    expect(validateRecipeCommentBody('   ')).toEqual({
      ok: false,
      error: 'Enter a comment before posting.',
    });
    expect(validateRecipeCommentBody('x'.repeat(4001)).ok).toBe(false);
    expect(validateRecipeCommentBody('  Great crust tip!  ')).toEqual({
      ok: true,
      body_md: 'Great crust tip!',
    });

    const root: UiRecipeComment = {
      id: 'cmt_1',
      parent_comment_id: null,
      depth: 0,
      deleted: false,
      deleted_by_role: null,
      author_name: 'Clara Baker',
      author_key: 'usr_clara',
      body_md: 'Original note',
      created_at: '2026-11-27T10:00:00.000Z',
      edited_at: null,
      can_edit: true,
      can_delete: true,
    };
    const reply: UiRecipeComment = {
      id: 'cmt_2',
      parent_comment_id: 'cmt_1',
      depth: 1,
      deleted: false,
      deleted_by_role: null,
      author_name: 'Jonah Baker',
      author_key: 'usr_jonah',
      body_md: 'Helpful reply',
      created_at: '2026-11-27T10:05:00.000Z',
      edited_at: '2026-11-27T10:06:00.000Z',
      can_edit: false,
      can_delete: true,
    };
    const tombstone: UiRecipeComment = {
      ...root,
      id: 'cmt_tomb',
      deleted: true,
      deleted_by_role: 'admin',
      author_name: null,
      author_key: null,
      body_md: '',
      can_edit: false,
      can_delete: false,
    };
    const orphan: UiRecipeComment = {
      ...reply,
      id: 'cmt_orphan',
      parent_comment_id: 'cmt_missing_parent',
    };

    // Out-of-order reply before root still attaches to root; true orphan becomes standalone thread
    const threads = groupRecipeCommentThreads([reply, root, tombstone, orphan]);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      ['cmt_1', ['cmt_2']],
      ['cmt_tomb', []],
      ['cmt_orphan', []],
    ]);

    expect(countActiveRecipeComments([root, reply, tombstone])).toBe(2);
    expect(formatDeletedCommentTombstone('author')).toBe('[Comment removed]');
    expect(formatDeletedCommentTombstone(null)).toBe('[Comment removed]');
    expect(formatDeletedCommentTombstone('admin')).toBe('[Comment removed by an archive administrator]');

    expect(
      parseUiRecipeCommentsListResponse({
        recipe_id: 'rec_1',
        comments: [root, reply],
        comment_count: 2,
        permissions: { can_comment: true },
      }).comments
    ).toHaveLength(2);
    expect(parseUiCreateRecipeCommentResponse({ comment: root, comment_count: 1 }).comment_count).toBe(1);
    expect(parseUiUpdateRecipeCommentResponse({ comment: reply }).comment.edited_at).toBe(
      '2026-11-27T10:06:00.000Z'
    );
  });
});
