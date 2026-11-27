import type { PluginSettingScalarValue } from '@kinloom/core';
import { z } from 'zod';

export const OPEN_FINANCE_PLUGIN_ID = 'kinloom-open-finance';
export const OPEN_FINANCE_PUBLIC_ROUTE = '/api/open-finance/summary';
export const OPEN_FINANCE_ADMIN_ROUTE = '/api/admin/open-finance/config';

export const DONATION_PLATFORM_IDS = [
  'github_sponsors',
  'buy_me_a_coffee',
  'ko_fi',
  'open_collective',
  'stripe',
  'paypal_me',
] as const;

export const DonationPlatformIdSchema = z.enum(DONATION_PLATFORM_IDS);
export type DonationPlatformId = z.infer<typeof DonationPlatformIdSchema>;

export const OPEN_FINANCE_COST_CATEGORIES = [
  'domain',
  'hosting',
  'storage',
  'ai_tooling',
  'archival_subscriptions',
  'other',
] as const;

export const OpenFinanceCostCategorySchema = z.enum(OPEN_FINANCE_COST_CATEGORIES);
export type OpenFinanceCostCategory = z.infer<typeof OpenFinanceCostCategorySchema>;

export const OPEN_FINANCE_COST_CADENCES = ['monthly', 'annual', 'one_time'] as const;

export const OpenFinanceCostCadenceSchema = z.enum(OPEN_FINANCE_COST_CADENCES);
export type OpenFinanceCostCadence = z.infer<typeof OpenFinanceCostCadenceSchema>;

export const OPEN_FINANCE_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const;

export const OpenFinanceCurrencySchema = z.enum(OPEN_FINANCE_CURRENCIES);
export type OpenFinanceCurrency = z.infer<typeof OpenFinanceCurrencySchema>;

export type AllowlistedDonationUrl = string & { readonly __brand: 'AllowlistedDonationUrl' };

export interface DonationPlatformSpec {
  readonly id: DonationPlatformId;
  readonly name: string;
  readonly defaultCtaLabel: string;
  readonly allowedHosts: readonly string[];
  readonly canonicalHost: string;
  readonly canonicalPrefix: string;
  readonly pathMode: 'sponsors_prefix' | 'single_segment';
  readonly handlePattern: RegExp;
  readonly handleExample: string;
  readonly placeholderUrl: string;
  readonly settingFieldKey: string;
}

export const DONATION_PLATFORM_REGISTRY: Readonly<Record<DonationPlatformId, DonationPlatformSpec>> = {
  github_sponsors: {
    id: 'github_sponsors',
    name: 'GitHub Sponsors',
    defaultCtaLabel: 'Sponsor on GitHub',
    allowedHosts: ['github.com'],
    canonicalHost: 'github.com',
    canonicalPrefix: 'https://github.com/sponsors/',
    pathMode: 'sponsors_prefix',
    handlePattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
    handleExample: 'archive-steward',
    placeholderUrl: 'https://github.com/sponsors/archive-steward',
    settingFieldKey: 'github_sponsors_url',
  },
  buy_me_a_coffee: {
    id: 'buy_me_a_coffee',
    name: 'Buy Me a Coffee',
    defaultCtaLabel: 'Buy Me a Coffee',
    allowedHosts: ['buymeacoffee.com', 'www.buymeacoffee.com'],
    canonicalHost: 'buymeacoffee.com',
    canonicalPrefix: 'https://buymeacoffee.com/',
    pathMode: 'single_segment',
    handlePattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/,
    handleExample: 'alderarchive',
    placeholderUrl: 'https://buymeacoffee.com/alderarchive',
    settingFieldKey: 'buy_me_a_coffee_url',
  },
  ko_fi: {
    id: 'ko_fi',
    name: 'Ko-fi',
    defaultCtaLabel: 'Support on Ko-fi',
    allowedHosts: ['ko-fi.com', 'www.ko-fi.com'],
    canonicalHost: 'ko-fi.com',
    canonicalPrefix: 'https://ko-fi.com/',
    pathMode: 'single_segment',
    handlePattern: /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/,
    handleExample: 'alderarchive',
    placeholderUrl: 'https://ko-fi.com/alderarchive',
    settingFieldKey: 'kofi_url',
  },
  open_collective: {
    id: 'open_collective',
    name: 'Open Collective',
    defaultCtaLabel: 'Contribute on Open Collective',
    allowedHosts: ['opencollective.com', 'www.opencollective.com'],
    canonicalHost: 'opencollective.com',
    canonicalPrefix: 'https://opencollective.com/',
    pathMode: 'single_segment',
    handlePattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/,
    handleExample: 'alder-family-archive',
    placeholderUrl: 'https://opencollective.com/alder-family-archive',
    settingFieldKey: 'open_collective_url',
  },
  stripe: {
    id: 'stripe',
    name: 'Stripe Payment Link',
    defaultCtaLabel: 'Donate via Stripe',
    allowedHosts: ['buy.stripe.com'],
    canonicalHost: 'buy.stripe.com',
    canonicalPrefix: 'https://buy.stripe.com/',
    pathMode: 'single_segment',
    handlePattern: /^[A-Za-z0-9_-]{6,128}$/,
    handleExample: 'test_aEU000000000',
    placeholderUrl: 'https://buy.stripe.com/aEU000000000',
    settingFieldKey: 'stripe_payment_link_url',
  },
  paypal_me: {
    id: 'paypal_me',
    name: 'PayPal.me',
    defaultCtaLabel: 'Support via PayPal.me',
    allowedHosts: ['paypal.me', 'www.paypal.me'],
    canonicalHost: 'paypal.me',
    canonicalPrefix: 'https://paypal.me/',
    pathMode: 'single_segment',
    handlePattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/,
    handleExample: 'alderarchive',
    placeholderUrl: 'https://paypal.me/alderarchive',
    settingFieldKey: 'paypal_me_url',
  },
};

export type DonationUrlValidationResult =
  | {
      readonly ok: true;
      readonly url: AllowlistedDonationUrl;
      readonly handle: string;
      readonly host: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check rejecting ASCII control characters in donation URLs
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007F\\]/;
const ENCODED_SLASH_RE = /%(?:2f|5c)/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT_CENTS = 100_000_000;

/**
 * Strictly validates and canonicalizes a donation platform URL against the platform allowlist.
 * Rejects non-HTTPS protocols, credentials, custom ports, query/hash smuggling, arbitrary hosts,
 * path traversal, and malformed handles.
 */
export function validateDonationPlatformUrl(
  platform: DonationPlatformId,
  rawUrl: string
): DonationUrlValidationResult {
  const spec = DONATION_PLATFORM_REGISTRY[platform];
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: `${spec.name} URL is required.` };
  }
  if (CONTROL_OR_SPACE_RE.test(trimmed)) {
    return {
      ok: false,
      error: `${spec.name} URL must not contain whitespace, control characters, or backslashes.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: `${spec.name} URL must be a valid HTTPS URL (for example, ${spec.placeholderUrl}).`,
    };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: `${spec.name} URL must use https:// (got ${parsed.protocol}).` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, error: `${spec.name} URL must not include embedded credentials.` };
  }
  if (parsed.port !== '') {
    return { ok: false, error: `${spec.name} URL must not specify a custom port.` };
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, error: `${spec.name} URL must not include query parameters or hash fragments.` };
  }

  const host = parsed.hostname.toLowerCase();
  if (!spec.allowedHosts.includes(host)) {
    return {
      ok: false,
      error: `${spec.name} URL host '${host}' is not allowlisted (expected ${spec.allowedHosts.join(' or ')}).`,
    };
  }

  if (ENCODED_SLASH_RE.test(parsed.pathname)) {
    return { ok: false, error: `${spec.name} URL path contains disallowed encoded separators.` };
  }

  const rawSegments = parsed.pathname.split('/').filter(Boolean);
  for (const segment of rawSegments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, error: `${spec.name} URL path must not contain traversal segments.` };
    }
  }

  let handle: string;
  if (spec.pathMode === 'sponsors_prefix') {
    if (rawSegments.length !== 2 || rawSegments[0]?.toLowerCase() !== 'sponsors') {
      return {
        ok: false,
        error: `${spec.name} URL must match ${spec.canonicalPrefix}<handle>.`,
      };
    }
    handle = rawSegments[1] ?? '';
    if (handle.includes('--')) {
      return { ok: false, error: `${spec.name} handle '${handle}' must not contain consecutive hyphens.` };
    }
  } else {
    if (rawSegments.length !== 1) {
      return {
        ok: false,
        error: `${spec.name} URL must match ${spec.canonicalPrefix}<handle>.`,
      };
    }
    handle = rawSegments[0] ?? '';
  }

  if (!spec.handlePattern.test(handle) || handle.includes('..')) {
    return {
      ok: false,
      error: `${spec.name} handle '${handle}' is invalid (for example, ${spec.handleExample}).`,
    };
  }

  const canonical = `${spec.canonicalPrefix}${handle}` as AllowlistedDonationUrl;
  return {
    ok: true,
    url: canonical,
    handle,
    host: spec.canonicalHost,
  };
}

/**
 * Accepts either a full allowlisted HTTPS URL or a bare handle/slug for a supported platform
 * and validates it through the strict allowlist validator.
 */
export function buildDonationPlatformUrl(
  platform: DonationPlatformId,
  handleOrUrl: string
): DonationUrlValidationResult {
  const trimmed = handleOrUrl.trim();
  if (!trimmed) {
    return { ok: false, error: `${DONATION_PLATFORM_REGISTRY[platform].name} handle or URL is required.` };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.includes('://')) {
    return validateDonationPlatformUrl(platform, trimmed);
  }
  if (trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('@')) {
    return {
      ok: false,
      error: `${DONATION_PLATFORM_REGISTRY[platform].name} handle '${trimmed}' contains disallowed URL characters.`,
    };
  }
  const spec = DONATION_PLATFORM_REGISTRY[platform];
  return validateDonationPlatformUrl(platform, `${spec.canonicalPrefix}${trimmed}`);
}

export const OpenFinancePlatformInputSchema = z
  .object({
    platform: DonationPlatformIdSchema,
    url: z.string().trim().min(1).max(256).optional(),
    handle: z.string().trim().min(1).max(128).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(240).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export type OpenFinancePlatformInput = z.input<typeof OpenFinancePlatformInputSchema>;

export interface OpenFinancePlatformConfig {
  readonly platform: DonationPlatformId;
  readonly url: AllowlistedDonationUrl;
  readonly handle: string;
  readonly label: string;
  readonly description?: string;
  readonly enabled: boolean;
}

export const OpenFinanceCostItemSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'Cost item id must use [a-zA-Z0-9_.-].'),
    label: z.string().trim().min(1).max(120),
    category: OpenFinanceCostCategorySchema,
    cadence: OpenFinanceCostCadenceSchema,
    amount_cents: z.number().int().min(0).max(MAX_AMOUNT_CENTS),
    vendor: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(300).optional(),
    active: z.boolean().default(true),
  })
  .strict();

export type OpenFinanceCostItem = z.infer<typeof OpenFinanceCostItemSchema>;

export const OpenFinanceFundingGoalSchema = z
  .object({
    enabled: z.boolean().default(false),
    period: z.enum(['monthly', 'annual']).default('annual'),
    target_cents: z.number().int().min(0).max(MAX_AMOUNT_CENTS).default(0),
    received_cents: z.number().int().min(0).max(MAX_AMOUNT_CENTS).default(0),
    label: z.string().trim().max(120).optional(),
    as_of_date: z
      .string()
      .trim()
      .refine((v) => v === '' || ISO_DATE_RE.test(v), 'Funding goal as_of_date must be YYYY-MM-DD.')
      .optional(),
  })
  .strict();

export type OpenFinanceFundingGoal = z.infer<typeof OpenFinanceFundingGoalSchema>;

export const OpenFinanceVisibilitySchema = z
  .object({
    show_support_page: z.boolean().default(true),
    show_in_nav: z.boolean().default(true),
    show_in_footer: z.boolean().default(true),
  })
  .strict();

export type OpenFinanceVisibility = z.infer<typeof OpenFinanceVisibilitySchema>;

export const OpenFinanceConfigInputSchema = z
  .object({
    page_title: z.string().trim().min(1).max(120).default('Open Finance & Support'),
    nav_label: z.string().trim().min(1).max(40).default('Support'),
    supporter_message: z
      .string()
      .trim()
      .max(1200)
      .default(
        'This family archive publishes its real operating costs so relatives and supporters can see what it takes to preserve records online.'
      ),
    currency: OpenFinanceCurrencySchema.default('USD'),
    visibility: OpenFinanceVisibilitySchema.default({
      show_support_page: true,
      show_in_nav: true,
      show_in_footer: true,
    }),
    primary_platform: DonationPlatformIdSchema.nullable().default(null),
    platforms: z.array(OpenFinancePlatformInputSchema).max(DONATION_PLATFORM_IDS.length).default([]),
    cost_items: z.array(OpenFinanceCostItemSchema).max(100).default([]),
    funding_goal: OpenFinanceFundingGoalSchema.nullable().default(null),
  })
  .strict();

export type OpenFinanceConfigInput = z.input<typeof OpenFinanceConfigInputSchema>;

export interface OpenFinanceConfig {
  readonly page_title: string;
  readonly nav_label: string;
  readonly supporter_message: string;
  readonly currency: OpenFinanceCurrency;
  readonly visibility: OpenFinanceVisibility;
  readonly primary_platform: DonationPlatformId | null;
  readonly platforms: readonly OpenFinancePlatformConfig[];
  readonly cost_items: readonly OpenFinanceCostItem[];
  readonly funding_goal: OpenFinanceFundingGoal | null;
}

export interface OpenFinancePublicPlatform {
  readonly platform: DonationPlatformId;
  readonly name: string;
  readonly url: AllowlistedDonationUrl;
  readonly host: string;
  readonly handle: string;
  readonly label: string;
  readonly description?: string;
  readonly is_primary: boolean;
}

export interface OpenFinancePublicCostItem {
  readonly id: string;
  readonly label: string;
  readonly category: OpenFinanceCostCategory;
  readonly cadence: OpenFinanceCostCadence;
  readonly amount_cents: number;
  readonly monthly_equivalent_cents: number;
  readonly annual_equivalent_cents: number;
  readonly vendor?: string;
  readonly notes?: string;
}

export interface OpenFinanceFundingGoalSummary {
  readonly period: 'monthly' | 'annual';
  readonly target_cents: number;
  readonly received_cents: number;
  readonly remaining_cents: number;
  readonly progress_percent: number;
  readonly raw_percent: number;
  readonly label?: string;
  readonly as_of_date?: string;
}

export interface OpenFinanceCostTotals {
  readonly recurring_monthly_direct_cents: number;
  readonly recurring_annual_direct_cents: number;
  readonly monthly_operating_cents: number;
  readonly annual_operating_cents: number;
  readonly one_time_cents: number;
  readonly first_year_total_cents: number;
  readonly active_item_count: number;
}

export interface OpenFinancePublicSummary {
  readonly page_title: string;
  readonly nav_label: string;
  readonly supporter_message: string;
  readonly currency: OpenFinanceCurrency;
  readonly visibility: OpenFinanceVisibility;
  readonly platforms: readonly OpenFinancePublicPlatform[];
  readonly cost_items: readonly OpenFinancePublicCostItem[];
  readonly totals: OpenFinanceCostTotals;
  readonly funding_goal: OpenFinanceFundingGoalSummary | null;
  readonly updated_at: string | null;
}

export interface OpenFinanceAdminConfigResponse {
  readonly config: OpenFinanceConfig;
  readonly summary: OpenFinancePublicSummary;
  readonly updated_at: string | null;
  readonly updated_by: string | null;
  readonly persistence_available: boolean;
}

export type ParseOpenFinanceConfigResult =
  | { readonly ok: true; readonly config: OpenFinanceConfig }
  | { readonly ok: false; readonly fieldErrors: Readonly<Record<string, string>> };

/**
 * Parses and strictly validates an untrusted open-finance configuration payload at the boundary.
 * All donation URLs and handles pass through the strict platform allowlist before entering domain state.
 */
export function validateOpenFinanceConfig(raw: unknown): ParseOpenFinanceConfigResult {
  const parsed = OpenFinanceConfigInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const pathKey = issue.path.length > 0 ? issue.path.join('.') : '_root';
      if (!fieldErrors[pathKey]) {
        fieldErrors[pathKey] = issue.message;
      }
    }
    return { ok: false, fieldErrors };
  }

  const data = parsed.data;
  const fieldErrors: Record<string, string> = {};
  const seenPlatforms = new Set<DonationPlatformId>();
  const normalizedPlatforms: OpenFinancePlatformConfig[] = [];

  for (let i = 0; i < data.platforms.length; i += 1) {
    const entry = data.platforms[i];
    if (!entry) {
      continue;
    }
    const fieldPrefix = `platforms.${i}`;
    if (seenPlatforms.has(entry.platform)) {
      fieldErrors[`${fieldPrefix}.platform`] = `Duplicate donation platform '${entry.platform}'.`;
      continue;
    }
    seenPlatforms.add(entry.platform);

    const spec = DONATION_PLATFORM_REGISTRY[entry.platform];
    const urlResult = entry.url
      ? validateDonationPlatformUrl(entry.platform, entry.url)
      : entry.handle
        ? buildDonationPlatformUrl(entry.platform, entry.handle)
        : ({ ok: false, error: `${spec.name} requires a valid HTTPS URL or handle.` } as const);

    if (!urlResult.ok) {
      fieldErrors[`${fieldPrefix}.url`] = urlResult.error;
      continue;
    }

    normalizedPlatforms.push({
      platform: entry.platform,
      url: urlResult.url,
      handle: urlResult.handle,
      label: entry.label?.trim() || spec.defaultCtaLabel,
      ...(entry.description && entry.description.trim().length > 0
        ? { description: entry.description.trim() }
        : {}),
      enabled: entry.enabled,
    });
  }

  const seenItemIds = new Set<string>();
  const normalizedItems: OpenFinanceCostItem[] = [];
  for (let i = 0; i < data.cost_items.length; i += 1) {
    const item = data.cost_items[i];
    if (!item) {
      continue;
    }
    if (seenItemIds.has(item.id)) {
      fieldErrors[`cost_items.${i}.id`] = `Duplicate cost item id '${item.id}'.`;
      continue;
    }
    seenItemIds.add(item.id);
    normalizedItems.push({
      id: item.id,
      label: item.label,
      category: item.category,
      cadence: item.cadence,
      amount_cents: item.amount_cents,
      ...(item.vendor && item.vendor.length > 0 ? { vendor: item.vendor } : {}),
      ...(item.notes && item.notes.length > 0 ? { notes: item.notes } : {}),
      active: item.active,
    });
  }

  let primaryPlatform = data.primary_platform;
  if (primaryPlatform !== null) {
    const matchingEnabled = normalizedPlatforms.some((p) => p.platform === primaryPlatform && p.enabled);
    if (!matchingEnabled && !fieldErrors.primary_platform) {
      fieldErrors.primary_platform = `Primary platform '${primaryPlatform}' must be configured and enabled.`;
    }
  } else {
    const firstEnabled = normalizedPlatforms.find((p) => p.enabled);
    primaryPlatform = firstEnabled ? firstEnabled.platform : null;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const normalizedGoal: OpenFinanceFundingGoal | null = data.funding_goal
    ? {
        enabled: data.funding_goal.enabled,
        period: data.funding_goal.period,
        target_cents: data.funding_goal.target_cents,
        received_cents: data.funding_goal.received_cents,
        ...(data.funding_goal.label && data.funding_goal.label.length > 0
          ? { label: data.funding_goal.label }
          : {}),
        ...(data.funding_goal.as_of_date && data.funding_goal.as_of_date.length > 0
          ? { as_of_date: data.funding_goal.as_of_date }
          : {}),
      }
    : null;

  return {
    ok: true,
    config: {
      page_title: data.page_title,
      nav_label: data.nav_label,
      supporter_message: data.supporter_message,
      currency: data.currency,
      visibility: data.visibility,
      primary_platform: primaryPlatform,
      platforms: normalizedPlatforms,
      cost_items: normalizedItems,
      funding_goal: normalizedGoal,
    },
  };
}

export function parseOpenFinanceConfig(raw: unknown): OpenFinanceConfig {
  const result = validateOpenFinanceConfig(raw);
  if (!result.ok) {
    const firstMessage = Object.values(result.fieldErrors)[0] ?? 'Invalid open-finance configuration.';
    throw new RangeError(firstMessage);
  }
  return result.config;
}

export function createDefaultOpenFinanceConfig(): OpenFinanceConfig {
  return parseOpenFinanceConfig({});
}

/**
 * Exact integer-cents cost rollup with zero floating-point drift across recurring monthly,
 * recurring annual, and one-time operating expenses.
 */
export function computeOpenFinanceTotals(costItems: readonly OpenFinanceCostItem[]): OpenFinanceCostTotals {
  let recurringMonthlyDirectCents = 0;
  let recurringAnnualDirectCents = 0;
  let oneTimeCents = 0;
  let activeItemCount = 0;

  for (const item of costItems) {
    if (item.active === false) {
      continue;
    }
    activeItemCount += 1;
    switch (item.cadence) {
      case 'monthly':
        recurringMonthlyDirectCents += item.amount_cents;
        break;
      case 'annual':
        recurringAnnualDirectCents += item.amount_cents;
        break;
      case 'one_time':
        oneTimeCents += item.amount_cents;
        break;
      default: {
        const _exhaustive: never = item.cadence;
        throw new Error(`Unhandled cadence: ${String(_exhaustive)}`);
      }
    }
  }

  const annualOperatingCents = recurringMonthlyDirectCents * 12 + recurringAnnualDirectCents;
  const monthlyOperatingCents = Math.round(annualOperatingCents / 12);
  const firstYearTotalCents = annualOperatingCents + oneTimeCents;

  return {
    recurring_monthly_direct_cents: recurringMonthlyDirectCents,
    recurring_annual_direct_cents: recurringAnnualDirectCents,
    monthly_operating_cents: monthlyOperatingCents,
    annual_operating_cents: annualOperatingCents,
    one_time_cents: oneTimeCents,
    first_year_total_cents: firstYearTotalCents,
    active_item_count: activeItemCount,
  };
}

export function computeFundingGoalSummary(
  goal: OpenFinanceFundingGoal | null,
  totals: OpenFinanceCostTotals
): OpenFinanceFundingGoalSummary | null {
  if (!goal?.enabled) {
    return null;
  }
  const effectiveTarget =
    goal.target_cents > 0
      ? goal.target_cents
      : goal.period === 'monthly'
        ? totals.monthly_operating_cents
        : totals.annual_operating_cents;

  const rawPercent = effectiveTarget > 0 ? Math.round((goal.received_cents * 100) / effectiveTarget) : 0;
  const progressPercent = Math.min(100, Math.max(0, rawPercent));
  const remainingCents = Math.max(0, effectiveTarget - goal.received_cents);

  return {
    period: goal.period,
    target_cents: effectiveTarget,
    received_cents: goal.received_cents,
    remaining_cents: remainingCents,
    progress_percent: progressPercent,
    raw_percent: rawPercent,
    ...(goal.label ? { label: goal.label } : {}),
    ...(goal.as_of_date ? { as_of_date: goal.as_of_date } : {}),
  };
}

export function buildOpenFinancePublicSummary(
  config: OpenFinanceConfig,
  updatedAt: string | null
): OpenFinancePublicSummary {
  const totals = computeOpenFinanceTotals(config.cost_items);
  const fundingGoal = computeFundingGoalSummary(config.funding_goal, totals);

  const enabledPlatforms = config.platforms.filter((p) => p.enabled);
  const effectivePrimary =
    config.primary_platform && enabledPlatforms.some((p) => p.platform === config.primary_platform)
      ? config.primary_platform
      : (enabledPlatforms[0]?.platform ?? null);

  const publicPlatforms: OpenFinancePublicPlatform[] = enabledPlatforms.map((entry) => {
    const spec = DONATION_PLATFORM_REGISTRY[entry.platform];
    return {
      platform: entry.platform,
      name: spec.name,
      url: entry.url,
      host: spec.canonicalHost,
      handle: entry.handle,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      is_primary: entry.platform === effectivePrimary,
    };
  });

  const publicItems: OpenFinancePublicCostItem[] = config.cost_items
    .filter((item) => item.active !== false)
    .map((item) => {
      const monthlyEquivalentCents =
        item.cadence === 'monthly'
          ? item.amount_cents
          : item.cadence === 'annual'
            ? Math.round(item.amount_cents / 12)
            : 0;
      const annualEquivalentCents =
        item.cadence === 'monthly'
          ? item.amount_cents * 12
          : item.cadence === 'annual'
            ? item.amount_cents
            : 0;

      return {
        id: item.id,
        label: item.label,
        category: item.category,
        cadence: item.cadence,
        amount_cents: item.amount_cents,
        monthly_equivalent_cents: monthlyEquivalentCents,
        annual_equivalent_cents: annualEquivalentCents,
        ...(item.vendor ? { vendor: item.vendor } : {}),
        ...(item.notes ? { notes: item.notes } : {}),
      };
    });

  return {
    page_title: config.page_title,
    nav_label: config.nav_label,
    supporter_message: config.supporter_message,
    currency: config.currency,
    visibility: config.visibility,
    platforms: publicPlatforms,
    cost_items: publicItems,
    totals,
    funding_goal: fundingGoal,
    updated_at: updatedAt,
  };
}

const CURRENCY_PREFIX: Readonly<Record<OpenFinanceCurrency, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'CA$',
  AUD: 'A$',
};

/**
 * Formats integer cents as currency using exact integer division and modulo (no float division).
 */
export function formatCurrencyCents(cents: number, currency: OpenFinanceCurrency = 'USD'): string {
  const safe = Number.isSafeInteger(cents) ? cents : Math.round(cents);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${CURRENCY_PREFIX[currency]}${grouped}.${frac}`;
}

/**
 * Serializes OpenFinanceConfig into flat PluginSettingsStore scalar values so both the dedicated
 * /api/admin/open-finance/config route and #44's declarative settingsSchema share one persisted store.
 */
export function openFinanceConfigToSettingsValues(
  config: OpenFinanceConfig
): Record<string, PluginSettingScalarValue> {
  const byPlatform = new Map(config.platforms.map((p) => [p.platform, p]));
  const values: Record<string, PluginSettingScalarValue> = {
    show_support_page: config.visibility.show_support_page,
    show_in_nav: config.visibility.show_in_nav,
    show_in_footer: config.visibility.show_in_footer,
    page_title: config.page_title,
    nav_label: config.nav_label,
    supporter_message: config.supporter_message,
    currency: config.currency,
    primary_platform: config.primary_platform ?? 'auto',
    platform_order_json: JSON.stringify(
      config.platforms.map((p) => ({
        platform: p.platform,
        url: p.url,
        label: p.label,
        ...(p.description ? { description: p.description } : {}),
        enabled: p.enabled,
      }))
    ),
    cost_ledger_json: JSON.stringify(config.cost_items),
    funding_goal_json: JSON.stringify(config.funding_goal),
  };

  for (const platformId of DONATION_PLATFORM_IDS) {
    const spec = DONATION_PLATFORM_REGISTRY[platformId];
    const entry = byPlatform.get(platformId);
    values[spec.settingFieldKey] = entry?.enabled ? entry.url : '';
  }

  return values;
}

function safeJsonParse(raw: PluginSettingScalarValue | undefined): unknown {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Rehydrates an OpenFinanceConfig from persisted PluginSettingsStore scalar values, merging any
 * platform URL updates edited via #44's declarative PluginSettingsSection.
 */
export function settingsValuesToOpenFinanceConfig(
  values: Readonly<Record<string, PluginSettingScalarValue>>,
  fallback: OpenFinanceConfig
): OpenFinanceConfig {
  const currency =
    typeof values.currency === 'string' &&
    (OPEN_FINANCE_CURRENCIES as readonly string[]).includes(values.currency)
      ? (values.currency as OpenFinanceCurrency)
      : fallback.currency;

  const pageTitle =
    typeof values.page_title === 'string' && values.page_title.trim().length > 0
      ? values.page_title.trim()
      : fallback.page_title;

  const navLabel =
    typeof values.nav_label === 'string' && values.nav_label.trim().length > 0
      ? values.nav_label.trim()
      : fallback.nav_label;

  const supporterMessage =
    typeof values.supporter_message === 'string'
      ? values.supporter_message.trim()
      : fallback.supporter_message;

  const visibility: OpenFinanceVisibility = {
    show_support_page:
      typeof values.show_support_page === 'boolean'
        ? values.show_support_page
        : fallback.visibility.show_support_page,
    show_in_nav:
      typeof values.show_in_nav === 'boolean' ? values.show_in_nav : fallback.visibility.show_in_nav,
    show_in_footer:
      typeof values.show_in_footer === 'boolean' ? values.show_in_footer : fallback.visibility.show_in_footer,
  };

  const parsedPlatformList = safeJsonParse(values.platform_order_json);
  const existingByPlatform = new Map<DonationPlatformId, OpenFinancePlatformInput>();
  const orderedIds: DonationPlatformId[] = [];

  if (Array.isArray(parsedPlatformList)) {
    for (const rawEntry of parsedPlatformList) {
      const checked = OpenFinancePlatformInputSchema.safeParse(rawEntry);
      if (checked.success && !existingByPlatform.has(checked.data.platform)) {
        existingByPlatform.set(checked.data.platform, checked.data);
        orderedIds.push(checked.data.platform);
      }
    }
  } else {
    for (const fb of fallback.platforms) {
      existingByPlatform.set(fb.platform, {
        platform: fb.platform,
        url: fb.url,
        label: fb.label,
        ...(fb.description ? { description: fb.description } : {}),
        enabled: fb.enabled,
      });
      orderedIds.push(fb.platform);
    }
  }

  for (const platformId of DONATION_PLATFORM_IDS) {
    const spec = DONATION_PLATFORM_REGISTRY[platformId];
    if (!Object.hasOwn(values, spec.settingFieldKey)) {
      continue;
    }
    const rawVal = values[spec.settingFieldKey];
    const urlStr = typeof rawVal === 'string' ? rawVal.trim() : '';
    if (urlStr.length > 0) {
      const prev = existingByPlatform.get(platformId);
      existingByPlatform.set(platformId, {
        platform: platformId,
        url: urlStr,
        label: prev?.label ?? spec.defaultCtaLabel,
        ...(prev?.description ? { description: prev.description } : {}),
        enabled: true,
      });
      if (!orderedIds.includes(platformId)) {
        orderedIds.push(platformId);
      }
    } else if (existingByPlatform.has(platformId)) {
      const prev = existingByPlatform.get(platformId);
      if (prev && prev.enabled !== false) {
        existingByPlatform.delete(platformId);
      }
    }
  }

  const platformsInput: OpenFinancePlatformInput[] = [];
  for (const id of orderedIds) {
    const entry = existingByPlatform.get(id);
    if (entry) {
      platformsInput.push(entry);
    }
  }

  const parsedCostItems = safeJsonParse(values.cost_ledger_json);
  const costItemsInput = Array.isArray(parsedCostItems) ? parsedCostItems : fallback.cost_items;

  const parsedGoal = safeJsonParse(values.funding_goal_json);
  const fundingGoalInput =
    parsedGoal === null || (typeof parsedGoal === 'object' && parsedGoal !== undefined)
      ? parsedGoal
      : fallback.funding_goal;

  const rawPrimary = values.primary_platform;
  let primaryPlatform: DonationPlatformId | null = fallback.primary_platform;
  if (rawPrimary === 'auto' || rawPrimary === null || rawPrimary === '') {
    primaryPlatform = null;
  } else if (
    typeof rawPrimary === 'string' &&
    (DONATION_PLATFORM_IDS as readonly string[]).includes(rawPrimary)
  ) {
    const candidate = rawPrimary as DonationPlatformId;
    const isEnabled = platformsInput.some((p) => p.platform === candidate && p.enabled !== false);
    primaryPlatform = isEnabled ? candidate : null;
  }

  const validated = validateOpenFinanceConfig({
    page_title: pageTitle,
    nav_label: navLabel,
    supporter_message: supporterMessage,
    currency,
    visibility,
    primary_platform: primaryPlatform,
    platforms: platformsInput,
    cost_items: costItemsInput,
    funding_goal: fundingGoalInput,
  });

  return validated.ok ? validated.config : fallback;
}
