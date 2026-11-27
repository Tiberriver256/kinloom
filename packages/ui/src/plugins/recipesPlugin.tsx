import {
  createHttpRecipesClient,
  createStaticRecipesClient,
  type RecipesClient,
} from '../adapters/recipesClient.js';
import { DEFAULT_RECIPES_ROUTE_BASE, type UiRecipeDetail, type UiRecipePhoto } from '../lib/recipesModel.js';
import { KINLOOM_UI_VERSION } from '../version.js';
import { RecipeCatalogPage, RecipeFavoritesPage } from './recipes/RecipeCatalogPage.js';
import { RecipeDetailPage } from './recipes/RecipeDetailPage.js';
import { IndexRecipesWidget, PersonRecipesSlot } from './recipes/RecipeSlots.js';
import { bindRecipesProvider } from './recipes/RecipesContext.js';
import type { KinloomUiPlugin, KinloomUiPluginNavMinRole, KinloomUiPluginSlotContext } from './types.js';

export const RECIPES_UI_PLUGIN_ID = 'kinloom-recipes-ui';

export interface RecipesUiPluginOptions {
  /**
   * When false, returns an inert disabled plugin with zero provider, zero routes,
   * zero slots, and zero network requests. Defaults to true when explicitly invoked.
   */
  readonly enabled?: boolean;
  /** Optional custom plugin ID override. Defaults to 'kinloom-recipes-ui'. */
  readonly id?: string;
  /** Base route path for the Family Recipe Box. Defaults to '/recipes'. */
  readonly basePath?: string;
  /** Label shown in top navigation and mobile menu. Defaults to 'Recipes'. */
  readonly navLabel?: string;
  /** Optional sort order among plugin navigation links. */
  readonly navOrder?: number;
  /** Optional minimum role required to display the Recipes navigation link. Defaults to 'public'. */
  readonly navMinRole?: KinloomUiPluginNavMinRole;
  /** Optional API base URL passed to the default HTTP client. */
  readonly apiBaseUrl?: string;
  /** Optional injected RecipesClient for tests or custom transports. */
  readonly client?: RecipesClient;
  /** Optional static recipe collection for static archives or hermetic previews. */
  readonly staticRecipes?: readonly UiRecipeDetail[];
  /** Optional static photos keyed by recipe ID when using `staticRecipes`. */
  readonly staticPhotosByRecipeId?: Readonly<Record<string, readonly UiRecipePhoto[]>>;
  /** Controls whether the IndexPage home widget shelf is mounted. Defaults to true. */
  readonly showIndexWidget?: boolean;
  /** Optional heading override for the catalog page and home shelf. */
  readonly pageTitle?: string;
  /** Optional subtitle override for the catalog page. */
  readonly pageDescription?: string;
}

const RecipeBookIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3.5 3.5h8.5a2 2 0 0 1 2 2v9H5.5a2 2 0 0 0-2 2v-13Z" />
    <path d="M14 14.5H5.5a2 2 0 0 0 0 0" />
    <path d="M6.5 7h4.5M6.5 10h3.5" />
  </svg>
);

/**
 * Optional, strictly off-by-default Kinloom UI plugin for Family Recipe Sharing.
 * Registers `/recipes`, `/recipes/favorites`, `/recipes/:slug`, plus `personRelated`
 * and `indexWidgets` archival slots.
 */
export function createRecipesUiPlugin(options: RecipesUiPluginOptions = {}): KinloomUiPlugin {
  const id = options.id?.trim() || RECIPES_UI_PLUGIN_ID;

  if (options.enabled === false) {
    return {
      id,
      name: 'Family Recipe Sharing UI (disabled)',
      version: KINLOOM_UI_VERSION,
      status: 'disabled',
    };
  }

  const basePath =
    options.basePath?.trim().replace(/\/+$/, '') || DEFAULT_RECIPES_ROUTE_BASE || DEFAULT_RECIPES_ROUTE_BASE;
  const showIndexWidget = options.showIndexWidget ?? true;

  const client: RecipesClient = options.client
    ? options.client
    : options.staticRecipes !== undefined
      ? createStaticRecipesClient({
          recipes: options.staticRecipes,
          photosByRecipeId: options.staticPhotosByRecipeId,
          showHomeWidget: showIndexWidget,
        })
      : createHttpRecipesClient({ apiBaseUrl: options.apiBaseUrl });

  const provider = bindRecipesProvider({
    client,
    basePath,
    showIndexWidget,
    pageTitle: options.pageTitle,
    pageDescription: options.pageDescription,
  });

  return {
    id,
    name: 'Family Recipe Sharing',
    version: KINLOOM_UI_VERSION,
    status: 'active',
    provider,
    routes: [
      {
        path: basePath,
        navLabel: options.navLabel?.trim() || 'Recipes',
        navMatchPrefix: basePath,
        navIcon: RecipeBookIcon,
        navOrder: options.navOrder,
        navMinRole: options.navMinRole ?? 'public',
        component: RecipeCatalogPage,
      },
      {
        path: `${basePath}/favorites`,
        component: RecipeFavoritesPage,
      },
      {
        path: `${basePath}/:slug`,
        component: RecipeDetailPage,
      },
    ],
    slots: {
      ...(showIndexWidget ? { indexWidgets: () => <IndexRecipesWidget /> } : {}),
      personRelated: (ctx: KinloomUiPluginSlotContext) =>
        ctx.person && !ctx.person.is_living && ctx.person.full_name !== 'Living' ? (
          <PersonRecipesSlot person={ctx.person} />
        ) : null,
    },
  };
}
