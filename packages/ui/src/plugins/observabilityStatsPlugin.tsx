import {
  createHttpObservabilityStatsClient,
  type ObservabilityStatsClient,
} from '../adapters/observabilityStatsClient.js';
import { isDeceasedPersonForBadge, type UiObservabilityStatsWindow } from '../lib/observabilityStatsModel.js';
import { KINLOOM_UI_VERSION } from '../version.js';
import { bindObservabilityStatsProvider } from './observabilityStats/ObservabilityStatsContext.js';
import { ObservabilityStatsPanel } from './observabilityStats/ObservabilityStatsPanel.js';
import { PageVisitBadge } from './observabilityStats/PageVisitBadge.js';
import { PageVisitBeaconTracker } from './observabilityStats/PageVisitBeaconTracker.js';
import type { KinloomUiPlugin, KinloomUiPluginSlotContext } from './types.js';

export const OBSERVABILITY_STATS_UI_PLUGIN_ID = 'kinloom-observability-stats-ui';

export interface ObservabilityStatsUiPluginOptions {
  /**
   * When false, returns an inert plugin with zero provider, zero slots, and zero network requests.
   * Defaults to true when the factory is explicitly invoked.
   */
  readonly enabled?: boolean;
  /** Optional custom plugin ID override. */
  readonly id?: string;
  /** Optional API base URL passed to the default HTTP client. */
  readonly apiBaseUrl?: string;
  /** Optional fetch credentials mode passed to the default HTTP client. */
  readonly credentials?: RequestCredentials;
  /** Optional injected transport client for hermetic tests or custom backends. */
  readonly client?: ObservabilityStatsClient;
  /** Initial display state for per-page visit badges. Defaults to false (off until enabled). */
  readonly showPublicVisitBadges?: boolean;
  /** Default rolling window selected in the Admin Settings panel. Defaults to '30d'. */
  readonly defaultWindow?: UiObservabilityStatsWindow;
}

/**
 * Optional, off-by-default Kinloom UI plugin that renders the privacy-first Archive Traffic &
 * Page Visit Stats dashboard in AdminSettingsShell and optional subtle archival visit count badges
 * on deceased person and place views, plus SPA route visit beacons.
 */
const OBSERVABILITY_STATS_UI_DOCS = {
  id: 'docs-observability-stats-ui',
  title: 'Page Visit Stats UI',
  summary: 'Aggregate page-view badges on deceased entity pages and an Admin readership summary panel.',
  sections: [
    {
      id: 'beacons-and-badges',
      heading: 'Beacons, Badges & Admin Summary',
      markdown:
        'Sends lightweight cookieless visit beacons for deceased people and places, renders optional visit count badges, and adds a readership overview to Site Administration.',
    },
  ],
} as const;

export function createObservabilityStatsPlugin(
  options: ObservabilityStatsUiPluginOptions = {}
): KinloomUiPlugin {
  const id = options.id ?? OBSERVABILITY_STATS_UI_PLUGIN_ID;

  if (options.enabled === false) {
    return {
      id,
      name: 'Page Visit Stats UI (disabled)',
      documentation: OBSERVABILITY_STATS_UI_DOCS,
      version: KINLOOM_UI_VERSION,
      changelog: [
        {
          version: '0.61.0',
          date: '2026-11-28',
          summary: 'Page Visit Stats dashboard, SPA visit beacon tracker, and public visit badges.',
          changes: [
            {
              category: 'added',
              text: 'Page Visit Stats dashboard, SPA visit beacon tracker, and public visit badges.',
            },
          ],
        },
      ],
      status: 'disabled',
    };
  }

  const client =
    options.client ??
    createHttpObservabilityStatsClient({
      apiBaseUrl: options.apiBaseUrl,
      credentials: options.credentials,
    });
  const initialShowPublicBadges = options.showPublicVisitBadges ?? false;
  const defaultWindow = options.defaultWindow ?? '30d';

  const provider = bindObservabilityStatsProvider({
    client,
    initialShowPublicBadges,
    defaultWindow,
  });

  return {
    id,
    name: 'Page Visit Stats',
    documentation: OBSERVABILITY_STATS_UI_DOCS,
    version: KINLOOM_UI_VERSION,
    status: 'active',
    provider,
    slots: {
      appShell: () => <PageVisitBeaconTracker />,
      adminSettings: (ctx: KinloomUiPluginSlotContext) =>
        ctx.capabilities.canManageSite ? <ObservabilityStatsPanel /> : null,
      personDetail: (ctx: KinloomUiPluginSlotContext) => {
        if (!isDeceasedPersonForBadge(ctx.person) || !ctx.person) {
          return null;
        }
        return <PageVisitBadge entityKind="person" entitySlug={ctx.person.slug} />;
      },
      placeDetail: (ctx: KinloomUiPluginSlotContext) => {
        if (!ctx.place?.slug.trim()) {
          return null;
        }
        return <PageVisitBadge entityKind="place" entitySlug={ctx.place.slug} />;
      },
    },
  };
}
