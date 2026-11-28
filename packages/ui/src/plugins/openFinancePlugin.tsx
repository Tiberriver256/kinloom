import { createHttpOpenFinanceClient, type OpenFinanceClient } from '../adapters/openFinanceClient.js';
import {
  DEFAULT_OPEN_FINANCE_ROUTE,
  normalizeUiOpenFinanceConfig,
  type UiOpenFinanceConfigInput,
} from '../lib/openFinanceModel.js';
import { KINLOOM_UI_VERSION } from '../version.js';
import { OpenFinanceAdminPanel } from './openFinance/OpenFinanceAdminPanel.js';
import {
  OpenFinanceFooterLink,
  OpenFinanceMobileMenuLink,
  OpenFinanceNavLink,
} from './openFinance/OpenFinanceChromeSlots.js';
import { bindOpenFinanceProvider } from './openFinance/OpenFinanceContext.js';
import { OpenFinanceSupportPage } from './openFinance/OpenFinanceSupportPage.js';
import type { KinloomUiPlugin, KinloomUiPluginSlotContext } from './types.js';

export const OPEN_FINANCE_UI_PLUGIN_ID = 'kinloom-open-finance-ui';

export interface OpenFinanceUiPluginOptions {
  /**
   * When false, returns an inert plugin with zero provider, zero routes, zero slots, and zero
   * network requests. Defaults to true when the factory is explicitly invoked.
   */
  readonly enabled?: boolean;
  /** Optional custom plugin ID override. */
  readonly id?: string;
  /** Route path for the public Open Finance & Support page. Defaults to '/support'. */
  readonly routePath?: string;
  /** Optional static or fallback open-finance configuration (strictly validated on creation). */
  readonly config?: UiOpenFinanceConfigInput;
  /** Optional API base URL passed to the default HTTP client. */
  readonly apiBaseUrl?: string;
  /** Optional fetch credentials mode passed to the default HTTP client. */
  readonly credentials?: RequestCredentials;
  /** Optional injected transport client for hermetic tests or custom backends. */
  readonly client?: OpenFinanceClient;
  /**
   * Set to false for purely static archives (e.g. GitHub Pages) to render solely from `config`
   * without calling `/api/open-finance/summary`. Defaults to true when no static-only override is set.
   */
  readonly liveSync?: boolean;
}

/**
 * Optional, off-by-default Kinloom UI plugin that renders the archival-styled Open Finance & Support
 * page (`/support`), optional navigation and footer links, and the Admin Settings ledger editor.
 */
export function createOpenFinancePlugin(options: OpenFinanceUiPluginOptions = {}): KinloomUiPlugin {
  const id = options.id ?? OPEN_FINANCE_UI_PLUGIN_ID;

  if (options.enabled === false) {
    return {
      id,
      name: 'Open Finance & Support UI (disabled)',
      version: KINLOOM_UI_VERSION,
      status: 'disabled',
    };
  }

  const routePath = options.routePath?.trim() || DEFAULT_OPEN_FINANCE_ROUTE;
  const initialConfig = options.config ? normalizeUiOpenFinanceConfig(options.config) : null;
  const shouldUseHttpClient = options.client !== undefined || options.liveSync !== false;
  const client: OpenFinanceClient | null = options.client
    ? options.client
    : shouldUseHttpClient
      ? createHttpOpenFinanceClient({
          apiBaseUrl: options.apiBaseUrl,
          credentials: options.credentials,
        })
      : null;

  const provider = bindOpenFinanceProvider({
    routePath,
    client,
    initialConfig,
  });

  return {
    id,
    name: 'Open Finance & Support',
    version: KINLOOM_UI_VERSION,
    status: 'active',
    provider,
    routes: [
      {
        path: routePath,
        component: OpenFinanceSupportPage,
      },
    ],
    slots: {
      topBarNav: () => <OpenFinanceNavLink />,
      topBarMobileMenu: () => <OpenFinanceMobileMenuLink />,
      footer: () => <OpenFinanceFooterLink />,
      adminSettings: (ctx: KinloomUiPluginSlotContext) =>
        ctx.capabilities.canManageSite ? <OpenFinanceAdminPanel /> : null,
    },
  };
}
