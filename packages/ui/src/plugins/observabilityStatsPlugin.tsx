import {
  createHttpObservabilityStatsClient,
  type ObservabilityStatsClient,
} from '../adapters/observabilityStatsClient.js';
import {
  isDeceasedPersonForBadge,
  isPublicNarrativeForBadge,
  type UiObservabilityStatsWindow,
} from '../lib/observabilityStatsModel.js';
import { KINLOOM_UI_VERSION } from '../version.js';
import { bindObservabilityStatsProvider } from './observabilityStats/ObservabilityStatsContext.js';
import { ObservabilityStatsPanel } from './observabilityStats/ObservabilityStatsPanel.js';
import { PageVisitBadge } from './observabilityStats/PageVisitBadge.js';
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
 * on deceased person, place, and non-living narrative views.
 */
export function createObservabilityStatsPlugin(
  options: ObservabilityStatsUiPluginOptions = {}
): KinloomUiPlugin {
  const id = options.id ?? OBSERVABILITY_STATS_UI_PLUGIN_ID;

  if (options.enabled === false) {
    return {
      id,
      name: 'Page Visit Stats UI (disabled)',
      version: KINLOOM_UI_VERSION,
      status: 'disabled',
    };
  }

  const client = options.client ?? createHttpObservabilityStatsClient({ apiBaseUrl: options.apiBaseUrl });
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
    version: KINLOOM_UI_VERSION,
    status: 'active',
    provider,
    slots: {
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
      narrativeHeader: (ctx: KinloomUiPluginSlotContext) => {
        if (!ctx.narrative || !isPublicNarrativeForBadge(ctx.narrative, ctx.person, ctx.bundle?.people)) {
          return null;
        }
        const slug = ctx.narrative.slug || ctx.narrative.id;
        return <PageVisitBadge entityKind="narrative" entitySlug={slug} />;
      },
    },
  };
}
