import type {
  KinloomServerPluginReadonlySettingsContext,
  PluginSettingField,
  PluginSettingScalarValue,
  PluginSettingsSchema,
} from '@kinloom/core';
import { z } from 'zod';
import { matchesIfNoneMatch, sha256Hex } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';
import { jsonResponse } from '../http/httpPrimitives.js';
import type { KinloomServerPlugin, KinloomServerPorts } from '../http/pluginLifecycle.js';
import { KINLOOM_SERVER_VERSION } from '../version.js';
import {
  buildOpenFinancePublicSummary,
  computeOpenFinanceTotals,
  createDefaultOpenFinanceConfig,
  DONATION_PLATFORM_IDS,
  DONATION_PLATFORM_REGISTRY,
  type DonationPlatformId,
  formatCurrencyCents,
  OPEN_FINANCE_ADMIN_ROUTE,
  OPEN_FINANCE_CURRENCIES,
  OPEN_FINANCE_PLUGIN_ID,
  OPEN_FINANCE_PUBLIC_ROUTE,
  type OpenFinanceAdminConfigResponse,
  type OpenFinanceConfig,
  type OpenFinanceConfigInput,
  OpenFinanceCostItemSchema,
  openFinanceConfigToSettingsValues,
  parseOpenFinanceConfig,
  settingsValuesToOpenFinanceConfig,
  validateDonationPlatformUrl,
  validateOpenFinanceConfig,
} from './openFinanceTypes.js';

export {
  type AllowlistedDonationUrl,
  buildDonationPlatformUrl,
  buildOpenFinancePublicSummary,
  computeFundingGoalSummary,
  computeOpenFinanceTotals,
  createDefaultOpenFinanceConfig,
  DONATION_PLATFORM_IDS,
  DONATION_PLATFORM_REGISTRY,
  type DonationPlatformId,
  DonationPlatformIdSchema,
  type DonationPlatformSpec,
  type DonationUrlValidationResult,
  formatCurrencyCents,
  OPEN_FINANCE_ADMIN_ROUTE,
  OPEN_FINANCE_COST_CADENCES,
  OPEN_FINANCE_COST_CATEGORIES,
  OPEN_FINANCE_CURRENCIES,
  OPEN_FINANCE_PLUGIN_ID,
  OPEN_FINANCE_PUBLIC_ROUTE,
  type OpenFinanceAdminConfigResponse,
  type OpenFinanceConfig,
  type OpenFinanceConfigInput,
  OpenFinanceConfigInputSchema,
  type OpenFinanceCostCadence,
  OpenFinanceCostCadenceSchema,
  type OpenFinanceCostCategory,
  OpenFinanceCostCategorySchema,
  type OpenFinanceCostItem,
  OpenFinanceCostItemSchema,
  type OpenFinanceCostTotals,
  type OpenFinanceCurrency,
  OpenFinanceCurrencySchema,
  type OpenFinanceFundingGoal,
  OpenFinanceFundingGoalSchema,
  type OpenFinanceFundingGoalSummary,
  type OpenFinancePlatformConfig,
  type OpenFinancePlatformInput,
  OpenFinancePlatformInputSchema,
  type OpenFinancePublicCostItem,
  type OpenFinancePublicPlatform,
  type OpenFinancePublicSummary,
  type OpenFinanceVisibility,
  OpenFinanceVisibilitySchema,
  openFinanceConfigToSettingsValues,
  type ParseOpenFinanceConfigResult,
  parseOpenFinanceConfig,
  settingsValuesToOpenFinanceConfig,
  validateDonationPlatformUrl,
  validateOpenFinanceConfig,
} from './openFinanceTypes.js';

export interface OpenFinancePluginOptions {
  /**
   * When false, returns a completely inert plugin with zero routes, zero settingsSchema,
   * and zero runtime footprint. Defaults to true when the factory is explicitly invoked.
   */
  readonly enabled?: boolean;
  /** Optional initial open-finance configuration (strictly validated at plugin registration time). */
  readonly config?: OpenFinanceConfigInput;
  /**
   * Minimum role for GET /api/open-finance/summary.
   * Defaults to 'archive_read' ('viewer' on private archives, 'public' on public archives).
   */
  readonly publicEndpointMinRole?: 'public' | 'archive_read' | 'viewer';
}

function buildSettingsSchema(initialConfig: OpenFinanceConfig): PluginSettingsSchema {
  const initialValues = openFinanceConfigToSettingsValues(initialConfig);
  const initialTotals = computeOpenFinanceTotals(initialConfig.cost_items);

  const platformFields: PluginSettingField[] = DONATION_PLATFORM_IDS.map((platformId) => {
    const spec = DONATION_PLATFORM_REGISTRY[platformId];
    return {
      key: spec.settingFieldKey,
      label: `${spec.name} URL`,
      type: 'url',
      allowedProtocols: ['https:'],
      defaultValue:
        typeof initialValues[spec.settingFieldKey] === 'string'
          ? String(initialValues[spec.settingFieldKey])
          : '',
      placeholder: spec.placeholderUrl,
      helpText: `Allowlisted HTTPS link (${spec.canonicalPrefix}<handle>). Leave blank to hide this platform.`,
      validate: (value) => {
        if (value === null || value === '') {
          return null;
        }
        if (typeof value !== 'string') {
          return `${spec.name} URL must be a valid HTTPS URL.`;
        }
        const checked = validateDonationPlatformUrl(platformId, value);
        return checked.ok ? null : checked.error;
      },
    };
  });

  return {
    title: 'Open Finance & Community Donations',
    description:
      'Publish transparent archive operating costs and strictly allowlisted external donation links. Zero payment custody and zero third-party payment scripts.',
    preserveKeys: ['platform_order_json', 'funding_goal_json'],
    sections: [
      {
        id: 'status',
        title: 'Ledger Status',
        description: 'Read-only runtime summary of active donation channels and operating cost totals.',
        fields: [
          {
            key: 'plugin_status',
            label: 'Open Finance Status',
            type: 'readonly',
            defaultValue: 'active',
          },
          {
            key: 'active_platforms_count',
            label: 'Active Donation Platforms',
            type: 'readonly',
            defaultValue: initialConfig.platforms.filter((p) => p.enabled).length,
          },
          {
            key: 'monthly_operating_cost',
            label: 'Monthly Operating Cost',
            type: 'readonly',
            defaultValue: formatCurrencyCents(initialTotals.monthly_operating_cents, initialConfig.currency),
          },
          {
            key: 'annual_operating_cost',
            label: 'Annual Operating Cost',
            type: 'readonly',
            defaultValue: formatCurrencyCents(initialTotals.annual_operating_cents, initialConfig.currency),
          },
          {
            key: 'storage_adapter',
            label: 'Settings Persistence',
            type: 'readonly',
            defaultValue: 'in-memory',
          },
        ],
      },
      {
        id: 'visibility',
        title: 'Visibility & Messaging',
        description: 'Control where open-finance links appear across the archive.',
        fields: [
          {
            key: 'show_support_page',
            label: 'Publish Open Finance & Support page',
            type: 'boolean',
            defaultValue: initialConfig.visibility.show_support_page,
            helpText: 'Displays the transparent cost ledger and allowlisted donation links on /support.',
          },
          {
            key: 'show_in_nav',
            label: 'Show Support link in top navigation',
            type: 'boolean',
            defaultValue: initialConfig.visibility.show_in_nav,
            helpText: "Requires 'Publish Open Finance & Support page' to be enabled.",
          },
          {
            key: 'show_in_footer',
            label: 'Show Support link in site footer',
            type: 'boolean',
            defaultValue: initialConfig.visibility.show_in_footer,
            helpText: "Requires 'Publish Open Finance & Support page' to be enabled.",
          },
          {
            key: 'page_title',
            label: 'Support Page Title',
            type: 'string',
            required: true,
            minLength: 1,
            maxLength: 120,
            defaultValue: initialConfig.page_title,
          },
          {
            key: 'nav_label',
            label: 'Navigation & Footer Label',
            type: 'string',
            required: true,
            minLength: 1,
            maxLength: 40,
            defaultValue: initialConfig.nav_label,
          },
          {
            key: 'supporter_message',
            label: 'Supporter Message',
            type: 'text',
            maxLength: 1200,
            defaultValue: initialConfig.supporter_message,
          },
          {
            key: 'currency',
            label: 'Display Currency',
            type: 'select',
            required: true,
            defaultValue: initialConfig.currency,
            options: OPEN_FINANCE_CURRENCIES.map((code) => ({ value: code, label: code })),
          },
        ],
      },
      {
        id: 'platforms',
        title: 'Allowlisted Donation Platforms',
        description:
          'Configure one or more external donation platforms. Only strictly allowlisted HTTPS platform URLs are accepted.',
        fields: [
          ...platformFields,
          {
            key: 'primary_platform',
            label: 'Primary CTA Platform',
            type: 'select',
            required: true,
            defaultValue: initialConfig.primary_platform ?? 'auto',
            options: [
              { value: 'auto', label: 'First configured platform' },
              ...DONATION_PLATFORM_IDS.map((id) => ({
                value: id,
                label: DONATION_PLATFORM_REGISTRY[id].name,
              })),
            ],
            validate: (value, allValues) => {
              if (value === 'auto' || value === null || value === '') {
                return null;
              }
              if (
                typeof value !== 'string' ||
                !(DONATION_PLATFORM_IDS as readonly string[]).includes(value)
              ) {
                return 'Primary platform must be a supported donation platform.';
              }
              const spec = DONATION_PLATFORM_REGISTRY[value as DonationPlatformId];
              const urlValue = allValues[spec.settingFieldKey];
              if (typeof urlValue !== 'string' || urlValue.trim().length === 0) {
                return `Configure a valid ${spec.name} URL before selecting it as the primary platform.`;
              }
              return null;
            },
          },
        ],
      },
      {
        id: 'ledger',
        title: 'Cost Breakdown Ledger (JSON)',
        description:
          'Structured JSON storage for cost line items. Use the Open Finance & Donations editor panel below for interactive editing.',
        fields: [
          {
            key: 'cost_ledger_json',
            label: 'Cost Line Items JSON',
            type: 'text',
            defaultValue: JSON.stringify(initialConfig.cost_items),
            helpText: 'JSON array of cost items with integer amount_cents values.',
            validate: (value) => {
              if (value === null || value === '') {
                return null;
              }
              if (typeof value !== 'string') {
                return 'Cost ledger must be a JSON string.';
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(value);
              } catch {
                return 'Cost ledger JSON is malformed.';
              }
              const checked = z.array(OpenFinanceCostItemSchema).max(100).safeParse(parsed);
              if (!checked.success) {
                return checked.error.issues[0]?.message ?? 'Invalid cost ledger item.';
              }
              return null;
            },
          },
        ],
      },
    ],
  };
}

/**
 * Optional, off-by-default Kinloom server plugin for open-cost transparency and allowlisted
 * multi-platform community donation links. Zero payment custody and zero @kinloom/core coupling.
 */
const OPEN_FINANCE_DOCS = {
  id: 'docs-open-finance',
  title: 'Open Finance & Donations',
  summary: 'Transparent archive operating ledger and optional family donation links.',
  sections: [
    {
      id: 'ledger-management',
      heading: 'Operating Costs & Transparency Ledger',
      markdown:
        'Track recurring hosting, domain, and archival preservation expenses in a public or member-visible transparency ledger alongside optional support links.',
    },
    {
      id: 'visibility',
      heading: 'Visibility & Access',
      markdown:
        'Control whether the Support & Finance page appears in site navigation and footer links from **Plugins & Integrations**. Only `admin` users can modify ledger entries.',
    },
  ],
} as const;

export function createOpenFinancePlugin(options: OpenFinancePluginOptions = {}): KinloomServerPlugin {
  if (options.enabled === false) {
    return {
      id: OPEN_FINANCE_PLUGIN_ID,
      name: 'Open Finance & Donations (disabled)',
      documentation: OPEN_FINANCE_DOCS,
      version: KINLOOM_SERVER_VERSION,
      changelog: [
        {
          version: '0.61.0',
          date: '2026-11-28',
          summary: 'Open Finance ledger API, allowlisted funding links, and runtime settings sync.',
          changes: [
            {
              category: 'added',
              text: 'Open Finance ledger API, allowlisted funding links, and runtime settings sync.',
            },
          ],
        },
      ],
      status: 'disabled',
      getStatus: () => ({ status: 'disabled', detail: 'Disabled via plugin options' }),
    };
  }

  let runtimeConfig: OpenFinanceConfig = options.config
    ? parseOpenFinanceConfig(options.config)
    : createDefaultOpenFinanceConfig();
  let lastUpdatedAt: string | null = null;
  let lastUpdatedBy: string | null = null;

  const publicEndpointMinRole = options.publicEndpointMinRole ?? 'archive_read';
  const settingsSchema = buildSettingsSchema(runtimeConfig);

  async function resolveCurrentState(ports: KinloomServerPorts): Promise<{
    readonly config: OpenFinanceConfig;
    readonly updatedAt: string | null;
    readonly updatedBy: string | null;
    readonly persistenceAvailable: boolean;
  }> {
    if (!ports.pluginSettingsStore) {
      return {
        config: runtimeConfig,
        updatedAt: lastUpdatedAt,
        updatedBy: lastUpdatedBy,
        persistenceAvailable: false,
      };
    }

    try {
      const stored = await ports.pluginSettingsStore.getSettings(OPEN_FINANCE_PLUGIN_ID);
      if (stored) {
        const resolved = settingsValuesToOpenFinanceConfig(stored.values, runtimeConfig);
        runtimeConfig = resolved;
        lastUpdatedAt = stored.updated_at;
        lastUpdatedBy = stored.updated_by;
        return {
          config: resolved,
          updatedAt: stored.updated_at,
          updatedBy: stored.updated_by,
          persistenceAvailable: true,
        };
      }
    } catch {
      // Fall back to in-memory config when plugin settings table is unavailable.
    }

    return {
      config: runtimeConfig,
      updatedAt: lastUpdatedAt,
      updatedBy: lastUpdatedBy,
      persistenceAvailable: true,
    };
  }

  return {
    id: OPEN_FINANCE_PLUGIN_ID,
    name: 'Open Finance & Donations',
    documentation: OPEN_FINANCE_DOCS,
    version: KINLOOM_SERVER_VERSION,
    status: 'active',
    settingsSchema,
    getStatus: () => {
      const activePlatforms = runtimeConfig.platforms.filter((p) => p.enabled).length;
      const activeItems = runtimeConfig.cost_items.filter((i) => i.active !== false).length;
      return {
        status: 'active',
        detail: `${activePlatforms} platform(s), ${activeItems} cost item(s)`,
      };
    },
    getReadonlySettings: (
      ctx: KinloomServerPluginReadonlySettingsContext
    ): Readonly<Record<string, PluginSettingScalarValue>> => {
      const serverPorts = ctx.ports as KinloomServerPorts;
      const effectiveConfig = settingsValuesToOpenFinanceConfig(ctx.values, runtimeConfig);
      const totals = computeOpenFinanceTotals(effectiveConfig.cost_items);
      return {
        plugin_status: 'active',
        active_platforms_count: effectiveConfig.platforms.filter((p) => p.enabled).length,
        monthly_operating_cost: formatCurrencyCents(totals.monthly_operating_cents, effectiveConfig.currency),
        annual_operating_cost: formatCurrencyCents(totals.annual_operating_cents, effectiveConfig.currency),
        storage_adapter: serverPorts.pluginSettingsStore?.adapterKind ?? 'in-memory',
      };
    },
    onSettingsUpdated: (event) => {
      runtimeConfig = settingsValuesToOpenFinanceConfig(event.values, runtimeConfig);
    },
    routes: [
      {
        method: 'GET',
        pathPrefix: OPEN_FINANCE_PUBLIC_ROUTE,
        minRole: publicEndpointMinRole,
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== OPEN_FINANCE_PUBLIC_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }
          const serverPorts = ctx.ports as KinloomServerPorts;
          const state = await resolveCurrentState(serverPorts);
          const summary = buildOpenFinancePublicSummary(state.config, state.updatedAt);
          const cacheControl = ctx.mode === 'public' ? 'no-cache' : 'private, no-cache';
          const hash = await sha256Hex(JSON.stringify(summary));
          const etag = `"of-${hash.slice(0, 24)}"`;
          if (matchesIfNoneMatch(ctx.request.headers.get('if-none-match'), etag)) {
            return new Response(null, {
              status: 304,
              headers: {
                'cache-control': cacheControl,
                etag,
              },
            });
          }
          return jsonResponse(summary, 200, {
            'cache-control': cacheControl,
            etag,
          });
        },
      },
      {
        method: 'GET',
        pathPrefix: OPEN_FINANCE_ADMIN_ROUTE,
        minRole: 'admin',
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== OPEN_FINANCE_ADMIN_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }
          const serverPorts = ctx.ports as KinloomServerPorts;
          const state = await resolveCurrentState(serverPorts);
          const payload: OpenFinanceAdminConfigResponse = {
            config: state.config,
            summary: buildOpenFinancePublicSummary(state.config, state.updatedAt),
            updated_at: state.updatedAt,
            updated_by: state.updatedBy,
            persistence_available: state.persistenceAvailable,
          };
          return jsonResponse(payload, 200, { 'cache-control': 'no-store' });
        },
      },
      {
        method: 'PUT',
        pathPrefix: OPEN_FINANCE_ADMIN_ROUTE,
        minRole: 'admin',
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== OPEN_FINANCE_ADMIN_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route PUT ${ctx.url.pathname} was not found.`);
          }

          let rawBody: unknown;
          try {
            rawBody = await ctx.request.json();
          } catch {
            throw new KinloomHttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
          }

          const validated = validateOpenFinanceConfig(rawBody);
          if (!validated.ok) {
            const firstMessage =
              Object.values(validated.fieldErrors)[0] ?? 'Open-finance configuration validation failed.';
            throw new KinloomHttpError(422, 'VALIDATION_ERROR', firstMessage, {
              field_errors: validated.fieldErrors,
            });
          }

          const serverPorts = ctx.ports as KinloomServerPorts;
          const nowIso = serverPorts.clock.nowIso();
          const updatedBy =
            ctx.principal.kind === 'user'
              ? ctx.principal.email
              : ctx.principal.kind === 'agent'
                ? ctx.principal.token_id
                : 'admin';

          if (serverPorts.pluginSettingsStore) {
            const saved = await serverPorts.pluginSettingsStore.savePluginSettings({
              pluginId: OPEN_FINANCE_PLUGIN_ID,
              values: openFinanceConfigToSettingsValues(validated.config),
              secretMutations: [],
              updatedBy,
              updatedAt: nowIso,
            });
            runtimeConfig = validated.config;
            lastUpdatedAt = saved.settings.updated_at;
            lastUpdatedBy = saved.settings.updated_by;
          } else {
            runtimeConfig = validated.config;
            lastUpdatedAt = nowIso;
            lastUpdatedBy = updatedBy;
          }

          const payload: OpenFinanceAdminConfigResponse = {
            config: runtimeConfig,
            summary: buildOpenFinancePublicSummary(runtimeConfig, lastUpdatedAt),
            updated_at: lastUpdatedAt,
            updated_by: lastUpdatedBy,
            persistence_available: Boolean(serverPorts.pluginSettingsStore),
          };
          return jsonResponse(payload, 200, { 'cache-control': 'no-store' });
        },
      },
    ],
  };
}
