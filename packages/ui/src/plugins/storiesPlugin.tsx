import type { SpecialtyStory } from '@kinloom/core';
import {
  createHttpStoriesClient,
  createStaticStoriesClient,
  type StoriesClient,
} from '../adapters/storiesClient.js';
import { DEFAULT_STORIES_ROUTE_BASE } from '../lib/storiesModel.js';
import { KINLOOM_UI_VERSION } from '../version.js';
import { bindStoriesProvider } from './stories/StoriesContext.js';
import { StoriesIndexPage } from './stories/StoriesIndexPage.js';
import { StoriesPersonSlot } from './stories/StoriesPersonSlot.js';
import { StoryPlayerPage } from './stories/StoryPlayerPage.js';
import type { KinloomUiPlugin, KinloomUiPluginNavMinRole, KinloomUiPluginSlotContext } from './types.js';

export const STORIES_UI_PLUGIN_ID = 'kinloom-stories-ui';

export interface StoriesUiPluginOptions {
  /** When false, returns an inert disabled plugin with zero routes and zero slots. */
  readonly enabled?: boolean;
  /** Optional custom plugin ID override. Defaults to 'kinloom-stories-ui'. */
  readonly id?: string;
  /** Base route path for Specialty Stories. Defaults to '/stories'. */
  readonly basePath?: string;
  /** Label shown in navigation chrome. Defaults to 'Stories'. */
  readonly navLabel?: string;
  /** Optional sort order among plugin navigation links. */
  readonly navOrder?: number;
  /** Minimum role required to show navigation link. Defaults to 'public'. */
  readonly navMinRole?: KinloomUiPluginNavMinRole;
  /** Optional base URL for the default HTTP stories client. */
  readonly baseUrl?: string;
  /** Optional injected StoriesClient for tests or custom transports. */
  readonly client?: StoriesClient;
  /** Optional static stories array for static archives or previews. */
  readonly staticStories?: readonly SpecialtyStory[];
  /** Optional heading override for the /stories index page. */
  readonly pageTitle?: string;
  /** Optional subtitle override for the /stories index page. */
  readonly pageDescription?: string;
}

const StoriesIcon = (
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
    <rect x="2.5" y="3.5" width="13" height="11" rx="1.5" />
    <path d="M7.5 6.75L11.5 9L7.5 11.25V6.75Z" />
  </svg>
);

const STORIES_UI_DOCS = {
  id: 'docs-stories-ui',
  title: 'Specialty Stories UI',
  summary: 'Interactive Documentary, Scroll Story, and Journey Map players with PersonPage integration.',
  sections: [
    {
      id: 'routes-and-slots',
      heading: 'Routes & Person Profile Integration',
      markdown:
        'Registers `/stories` and `/stories/:slug` interactive players and mounts a compact Specialty Stories section in the `personDetail` slot on PersonPage.',
    },
  ],
} as const;

function normalizeBasePath(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return trimmed.slice(0, end) || DEFAULT_STORIES_ROUTE_BASE;
}

export function createStoriesUiPlugin(options: StoriesUiPluginOptions = {}): KinloomUiPlugin {
  const id = options.id?.trim() || STORIES_UI_PLUGIN_ID;

  if (options.enabled === false) {
    return {
      id,
      name: 'Specialty Stories (disabled)',
      documentation: STORIES_UI_DOCS,
      version: KINLOOM_UI_VERSION,
      status: 'disabled',
    };
  }

  const basePath = normalizeBasePath(options.basePath);
  const client: StoriesClient = options.client
    ? options.client
    : options.staticStories !== undefined
      ? createStaticStoriesClient({ stories: options.staticStories })
      : createHttpStoriesClient({ baseUrl: options.baseUrl });

  const provider = bindStoriesProvider({
    client,
    basePath,
    pageTitle: options.pageTitle,
    pageDescription: options.pageDescription,
  });

  return {
    id,
    name: 'Specialty Stories',
    documentation: STORIES_UI_DOCS,
    version: KINLOOM_UI_VERSION,
    status: 'active',
    provider,
    routes: [
      {
        path: basePath,
        navLabel: options.navLabel?.trim() || 'Stories',
        navMatchPrefix: basePath,
        navIcon: StoriesIcon,
        navOrder: options.navOrder,
        navMinRole: options.navMinRole ?? 'public',
        component: StoriesIndexPage,
      },
      {
        path: `${basePath}/:slug`,
        component: StoryPlayerPage,
      },
    ],
    slots: {
      personDetail: (ctx: KinloomUiPluginSlotContext) =>
        ctx.person && !ctx.person.is_living && ctx.person.full_name !== 'Living' ? (
          <StoriesPersonSlot person={ctx.person} />
        ) : null,
    },
  };
}

export const storiesUiPlugin: KinloomUiPlugin = createStoriesUiPlugin();
