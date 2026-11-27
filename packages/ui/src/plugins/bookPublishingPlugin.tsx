import {
  type BookPublishingClient,
  createHttpBookPublishingClient,
} from '../adapters/bookPublishingClient.js';
import { KINLOOM_UI_VERSION } from '../version.js';
import { BookPublishingAdminPanel } from './bookPublishing/BookPublishingAdminPanel.js';
import { bindBookPublishingProvider } from './bookPublishing/BookPublishingContext.js';
import type { KinloomUiPlugin, KinloomUiPluginSlotContext } from './types.js';

export const BOOK_PUBLISHING_UI_PLUGIN_ID = 'kinloom-book-publishing-ui';

export interface BookPublishingUiPluginOptions {
  /**
   * When false, returns an inert disabled plugin with zero provider, zero routes, zero slots,
   * and zero network requests. Defaults to true when the factory is explicitly invoked.
   */
  readonly enabled?: boolean;
  /** Optional custom plugin ID override. */
  readonly id?: string;
  /** Optional API base URL passed to the default HTTP client. */
  readonly apiBaseUrl?: string;
  /** Optional injected transport client for hermetic tests or custom backends. */
  readonly client?: BookPublishingClient;
}

/**
 * Optional, strictly off-by-default Kinloom UI plugin rendering the admin-only Archival Hardcover
 * Book Publishing panel inside AdminSettingsShell (`slots.adminSettings`).
 */
export function createBookPublishingPlugin(options: BookPublishingUiPluginOptions = {}): KinloomUiPlugin {
  const id = options.id ?? BOOK_PUBLISHING_UI_PLUGIN_ID;

  if (options.enabled === false) {
    return {
      id,
      name: 'Archival Book Publishing UI (disabled)',
      version: KINLOOM_UI_VERSION,
      status: 'disabled',
    };
  }

  const client = options.client ?? createHttpBookPublishingClient({ apiBaseUrl: options.apiBaseUrl });
  const provider = bindBookPublishingProvider({ client });

  return {
    id,
    name: 'Archival Book Publishing',
    version: KINLOOM_UI_VERSION,
    status: 'active',
    provider,
    slots: {
      adminSettings: (ctx: KinloomUiPluginSlotContext) =>
        ctx.capabilities.canManageSite ? <BookPublishingAdminPanel /> : null,
    },
  };
}
