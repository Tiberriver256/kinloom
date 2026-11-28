export const OPEN_FINANCE_SERVER_PLUGIN_ID = 'kinloom-open-finance';
export const DEFAULT_OPEN_FINANCE_ROUTE = '/support';

export const UI_DONATION_PLATFORM_IDS = [
  'github_sponsors',
  'buy_me_a_coffee',
  'ko_fi',
  'open_collective',
  'stripe',
  'paypal_me',
] as const;

export type UiDonationPlatformId = (typeof UI_DONATION_PLATFORM_IDS)[number];

export const UI_OPEN_FINANCE_COST_CATEGORIES = [
  'domain',
  'hosting',
  'storage',
  'ai_tooling',
  'archival_subscriptions',
  'other',
] as const;

export type UiOpenFinanceCostCategory = (typeof UI_OPEN_FINANCE_COST_CATEGORIES)[number];

export const UI_OPEN_FINANCE_COST_CADENCES = ['monthly', 'annual', 'one_time'] as const;

export type UiOpenFinanceCostCadence = (typeof UI_OPEN_FINANCE_COST_CADENCES)[number];

export const UI_OPEN_FINANCE_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const;

export type UiOpenFinanceCurrency = (typeof UI_OPEN_FINANCE_CURRENCIES)[number];

export type UiAllowlistedDonationUrl = string & { readonly __brand: 'UiAllowlistedDonationUrl' };

export interface UiDonationPlatformSpec {
  readonly id: UiDonationPlatformId;
  readonly name: string;
  readonly defaultCtaLabel: string;
  readonly allowedHosts: readonly string[];
  readonly canonicalHost: string;
  readonly canonicalPrefix: string;
  readonly pathMode: 'sponsors_prefix' | 'single_segment';
  readonly handlePattern: RegExp;
  readonly handleExample: string;
  readonly placeholderUrl: string;
}

export const UI_DONATION_PLATFORM_REGISTRY: Readonly<Record<UiDonationPlatformId, UiDonationPlatformSpec>> = {
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
  },
};

export interface UiOpenFinanceVisibility {
  readonly show_support_page: boolean;
  readonly show_in_nav: boolean;
  readonly show_in_footer: boolean;
}

export interface UiOpenFinancePlatformConfig {
  readonly platform: UiDonationPlatformId;
  readonly url: UiAllowlistedDonationUrl;
  readonly handle: string;
  readonly label: string;
  readonly description?: string;
  readonly enabled: boolean;
}

export interface UiOpenFinancePlatformInput {
  readonly platform: UiDonationPlatformId;
  readonly url?: string | undefined;
  readonly handle?: string | undefined;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly enabled?: boolean | undefined;
}

export interface UiOpenFinanceCostItem {
  readonly id: string;
  readonly label: string;
  readonly category: UiOpenFinanceCostCategory;
  readonly cadence: UiOpenFinanceCostCadence;
  readonly amount_cents: number;
  readonly vendor?: string;
  readonly notes?: string;
  readonly active?: boolean;
}

export interface UiOpenFinanceFundingGoal {
  readonly enabled: boolean;
  readonly period: 'monthly' | 'annual';
  readonly target_cents: number;
  readonly received_cents: number;
  readonly label?: string;
  readonly as_of_date?: string;
}

export interface UiOpenFinanceConfigInput {
  readonly page_title?: string;
  readonly nav_label?: string;
  readonly supporter_message?: string;
  readonly currency?: UiOpenFinanceCurrency;
  readonly visibility?: Partial<UiOpenFinanceVisibility>;
  readonly primary_platform?: UiDonationPlatformId | null;
  readonly platforms?: readonly UiOpenFinancePlatformInput[];
  readonly cost_items?: readonly UiOpenFinanceCostItem[];
  readonly funding_goal?: UiOpenFinanceFundingGoal | null;
}

export interface UiOpenFinanceConfig {
  readonly page_title: string;
  readonly nav_label: string;
  readonly supporter_message: string;
  readonly currency: UiOpenFinanceCurrency;
  readonly visibility: UiOpenFinanceVisibility;
  readonly primary_platform: UiDonationPlatformId | null;
  readonly platforms: readonly UiOpenFinancePlatformConfig[];
  readonly cost_items: readonly UiOpenFinanceCostItem[];
  readonly funding_goal: UiOpenFinanceFundingGoal | null;
}

export interface UiOpenFinancePublicPlatform {
  readonly platform: UiDonationPlatformId;
  readonly name: string;
  readonly url: UiAllowlistedDonationUrl;
  readonly host: string;
  readonly handle: string;
  readonly label: string;
  readonly description?: string;
  readonly is_primary: boolean;
}

export interface UiOpenFinancePublicCostItem {
  readonly id: string;
  readonly label: string;
  readonly category: UiOpenFinanceCostCategory;
  readonly cadence: UiOpenFinanceCostCadence;
  readonly amount_cents: number;
  readonly monthly_equivalent_cents: number;
  readonly annual_equivalent_cents: number;
  readonly vendor?: string;
  readonly notes?: string;
}

export interface UiOpenFinanceCostTotals {
  readonly recurring_monthly_direct_cents: number;
  readonly recurring_annual_direct_cents: number;
  readonly monthly_operating_cents: number;
  readonly annual_operating_cents: number;
  readonly one_time_cents: number;
  readonly first_year_total_cents: number;
  readonly active_item_count: number;
}

export interface UiOpenFinanceFundingGoalSummary {
  readonly period: 'monthly' | 'annual';
  readonly target_cents: number;
  readonly received_cents: number;
  readonly remaining_cents: number;
  readonly progress_percent: number;
  readonly raw_percent: number;
  readonly label?: string;
  readonly as_of_date?: string;
}

export interface UiOpenFinancePublicSummary {
  readonly page_title: string;
  readonly nav_label: string;
  readonly supporter_message: string;
  readonly currency: UiOpenFinanceCurrency;
  readonly visibility: UiOpenFinanceVisibility;
  readonly platforms: readonly UiOpenFinancePublicPlatform[];
  readonly cost_items: readonly UiOpenFinancePublicCostItem[];
  readonly totals: UiOpenFinanceCostTotals;
  readonly funding_goal: UiOpenFinanceFundingGoalSummary | null;
  readonly updated_at: string | null;
}

export interface UiOpenFinanceAdminConfigPayload {
  readonly config: UiOpenFinanceConfig;
  readonly summary: UiOpenFinancePublicSummary;
  readonly updated_at: string | null;
  readonly updated_by: string | null;
  readonly persistence_available: boolean;
}

export type UiDonationUrlValidationResult =
  | {
      readonly ok: true;
      readonly url: UiAllowlistedDonationUrl;
      readonly handle: string;
      readonly host: string;
    }
  | { readonly ok: false; readonly error: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check rejecting ASCII control characters in donation URLs
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007F\\]/;
const ENCODED_SLASH_RE = /%(?:2f|5c)/i;
const DECIMAL_MONEY_RE = /^\d+(?:\.\d{1,2})?$/;
const MAX_AMOUNT_CENTS = 100_000_000;

export function isUiDonationPlatformId(value: unknown): value is UiDonationPlatformId {
  return typeof value === 'string' && (UI_DONATION_PLATFORM_IDS as readonly string[]).includes(value);
}

export function isUiOpenFinanceCostCategory(value: unknown): value is UiOpenFinanceCostCategory {
  return typeof value === 'string' && (UI_OPEN_FINANCE_COST_CATEGORIES as readonly string[]).includes(value);
}

export function isUiOpenFinanceCostCadence(value: unknown): value is UiOpenFinanceCostCadence {
  return typeof value === 'string' && (UI_OPEN_FINANCE_COST_CADENCES as readonly string[]).includes(value);
}

export function isUiOpenFinanceCurrency(value: unknown): value is UiOpenFinanceCurrency {
  return typeof value === 'string' && (UI_OPEN_FINANCE_CURRENCIES as readonly string[]).includes(value);
}

/**
 * Strictly validates and canonicalizes a donation platform URL against the platform allowlist.
 * Re-enforced on the UI boundary so untrusted or tampered responses never render unsafe links.
 */
export function validateUiDonationPlatformUrl(
  platform: UiDonationPlatformId,
  rawUrl: string
): UiDonationUrlValidationResult {
  const spec = UI_DONATION_PLATFORM_REGISTRY[platform];
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

  const segments = parsed.pathname.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, error: `${spec.name} URL path must not contain traversal segments.` };
    }
  }

  let handle: string;
  if (spec.pathMode === 'sponsors_prefix') {
    if (segments.length !== 2 || segments[0]?.toLowerCase() !== 'sponsors') {
      return { ok: false, error: `${spec.name} URL must match ${spec.canonicalPrefix}<handle>.` };
    }
    handle = segments[1] ?? '';
    if (handle.includes('--')) {
      return { ok: false, error: `${spec.name} handle '${handle}' must not contain consecutive hyphens.` };
    }
  } else {
    if (segments.length !== 1) {
      return { ok: false, error: `${spec.name} URL must match ${spec.canonicalPrefix}<handle>.` };
    }
    handle = segments[0] ?? '';
  }

  if (!spec.handlePattern.test(handle) || handle.includes('..')) {
    return {
      ok: false,
      error: `${spec.name} handle '${handle}' is invalid (for example, ${spec.handleExample}).`,
    };
  }

  return {
    ok: true,
    url: `${spec.canonicalPrefix}${handle}` as UiAllowlistedDonationUrl,
    handle,
    host: spec.canonicalHost,
  };
}

export function buildUiDonationPlatformUrl(
  platform: UiDonationPlatformId,
  handleOrUrl: string
): UiDonationUrlValidationResult {
  const trimmed = handleOrUrl.trim();
  if (!trimmed) {
    return { ok: false, error: `${UI_DONATION_PLATFORM_REGISTRY[platform].name} handle or URL is required.` };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.includes('://')) {
    return validateUiDonationPlatformUrl(platform, trimmed);
  }
  if (trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('@')) {
    return {
      ok: false,
      error: `${UI_DONATION_PLATFORM_REGISTRY[platform].name} handle '${trimmed}' contains disallowed URL characters.`,
    };
  }
  return validateUiDonationPlatformUrl(
    platform,
    `${UI_DONATION_PLATFORM_REGISTRY[platform].canonicalPrefix}${trimmed}`
  );
}

const CURRENCY_PREFIX: Readonly<Record<UiOpenFinanceCurrency, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'CA$',
  AUD: 'A$',
};

export function formatUiCurrencyCents(cents: number, currency: UiOpenFinanceCurrency = 'USD'): string {
  const safe = Number.isSafeInteger(cents) ? cents : Math.round(cents);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${CURRENCY_PREFIX[currency]}${grouped}.${frac}`;
}

export function formatCentsToDecimalInput(cents: number): string {
  const safe = Number.isSafeInteger(cents) && cents >= 0 ? cents : 0;
  const whole = Math.trunc(safe / 100);
  const frac = String(safe % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

/**
 * Parses a decimal currency input string (e.g. "12.50" or "40") into exact integer cents
 * without floating-point multiplication drift.
 */
export function parseDecimalMoneyToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, '');
  if (!trimmed || !DECIMAL_MONEY_RE.test(trimmed)) {
    return null;
  }
  const [wholePart = '0', fracPart = ''] = trimmed.split('.');
  const paddedFrac = fracPart.padEnd(2, '0').slice(0, 2);
  const cents = Number.parseInt(wholePart, 10) * 100 + Number.parseInt(paddedFrac, 10);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_AMOUNT_CENTS) {
    return null;
  }
  return cents;
}

export function formatCostCategoryLabel(category: UiOpenFinanceCostCategory): string {
  switch (category) {
    case 'domain':
      return 'Domain Registration';
    case 'hosting':
      return 'Hosting & Edge Runtime';
    case 'storage':
      return 'Backup Storage';
    case 'ai_tooling':
      return 'AI & Research Tooling';
    case 'archival_subscriptions':
      return 'Archival Subscriptions';
    case 'other':
      return 'Other Operating Cost';
  }
}

export function formatCostCadenceLabel(cadence: UiOpenFinanceCostCadence): string {
  switch (cadence) {
    case 'monthly':
      return 'Monthly';
    case 'annual':
      return 'Annual';
    case 'one_time':
      return 'One-Time';
  }
}

export function computeUiOpenFinanceTotals(
  costItems: readonly UiOpenFinanceCostItem[]
): UiOpenFinanceCostTotals {
  let recurringMonthlyDirectCents = 0;
  let recurringAnnualDirectCents = 0;
  let oneTimeCents = 0;
  let activeItemCount = 0;

  for (const item of costItems) {
    if (item.active === false) {
      continue;
    }
    activeItemCount += 1;
    if (item.cadence === 'monthly') {
      recurringMonthlyDirectCents += item.amount_cents;
    } else if (item.cadence === 'annual') {
      recurringAnnualDirectCents += item.amount_cents;
    } else {
      oneTimeCents += item.amount_cents;
    }
  }

  const annualOperatingCents = recurringMonthlyDirectCents * 12 + recurringAnnualDirectCents;
  const monthlyOperatingCents = Math.round(annualOperatingCents / 12);

  return {
    recurring_monthly_direct_cents: recurringMonthlyDirectCents,
    recurring_annual_direct_cents: recurringAnnualDirectCents,
    monthly_operating_cents: monthlyOperatingCents,
    annual_operating_cents: annualOperatingCents,
    one_time_cents: oneTimeCents,
    first_year_total_cents: annualOperatingCents + oneTimeCents,
    active_item_count: activeItemCount,
  };
}

export function computeUiFundingGoalSummary(
  goal: UiOpenFinanceFundingGoal | null,
  totals: UiOpenFinanceCostTotals
): UiOpenFinanceFundingGoalSummary | null {
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
  return {
    period: goal.period,
    target_cents: effectiveTarget,
    received_cents: goal.received_cents,
    remaining_cents: Math.max(0, effectiveTarget - goal.received_cents),
    progress_percent: Math.min(100, Math.max(0, rawPercent)),
    raw_percent: rawPercent,
    ...(goal.label ? { label: goal.label } : {}),
    ...(goal.as_of_date ? { as_of_date: goal.as_of_date } : {}),
  };
}

export function normalizeUiOpenFinanceConfig(input: UiOpenFinanceConfigInput = {}): UiOpenFinanceConfig {
  const seenPlatforms = new Set<UiDonationPlatformId>();
  const platforms: UiOpenFinancePlatformConfig[] = [];

  for (const entry of input.platforms ?? []) {
    if (seenPlatforms.has(entry.platform)) {
      throw new RangeError(`Duplicate donation platform '${entry.platform}'.`);
    }
    seenPlatforms.add(entry.platform);
    const spec = UI_DONATION_PLATFORM_REGISTRY[entry.platform];
    const validated = entry.url
      ? validateUiDonationPlatformUrl(entry.platform, entry.url)
      : entry.handle
        ? buildUiDonationPlatformUrl(entry.platform, entry.handle)
        : ({ ok: false, error: `${spec.name} requires a valid HTTPS URL or handle.` } as const);
    if (!validated.ok) {
      throw new RangeError(validated.error);
    }
    platforms.push({
      platform: entry.platform,
      url: validated.url,
      handle: validated.handle,
      label: entry.label?.trim() || spec.defaultCtaLabel,
      ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
      enabled: entry.enabled !== false,
    });
  }

  const seenIds = new Set<string>();
  const costItems: UiOpenFinanceCostItem[] = [];
  for (const item of input.cost_items ?? []) {
    const id = item.id.trim();
    if (!id || seenIds.has(id)) {
      throw new RangeError(`Invalid or duplicate cost item id '${item.id}'.`);
    }
    if (
      !Number.isInteger(item.amount_cents) ||
      item.amount_cents < 0 ||
      item.amount_cents > MAX_AMOUNT_CENTS
    ) {
      throw new RangeError(`Cost item '${id}' amount_cents must be a non-negative integer.`);
    }
    seenIds.add(id);
    costItems.push({
      id,
      label: item.label.trim() || id,
      category: item.category,
      cadence: item.cadence,
      amount_cents: item.amount_cents,
      ...(item.vendor?.trim() ? { vendor: item.vendor.trim() } : {}),
      ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
      active: item.active !== false,
    });
  }

  const enabledPlatforms = platforms.filter((p) => p.enabled);
  let primaryPlatform = input.primary_platform ?? null;
  if (primaryPlatform !== null && !enabledPlatforms.some((p) => p.platform === primaryPlatform)) {
    throw new RangeError(`Primary platform '${primaryPlatform}' must be configured and enabled.`);
  }
  if (primaryPlatform === null) {
    primaryPlatform = enabledPlatforms[0]?.platform ?? null;
  }

  return {
    page_title: input.page_title?.trim() || 'Open Finance & Support',
    nav_label: input.nav_label?.trim() || 'Support',
    supporter_message:
      input.supporter_message !== undefined
        ? input.supporter_message.trim()
        : 'This family archive publishes its real operating costs so relatives and supporters can see what it takes to preserve records online.',
    currency: input.currency ?? 'USD',
    visibility: {
      show_support_page: input.visibility?.show_support_page ?? true,
      show_in_nav: input.visibility?.show_in_nav ?? true,
      show_in_footer: input.visibility?.show_in_footer ?? true,
    },
    primary_platform: primaryPlatform,
    platforms,
    cost_items: costItems,
    funding_goal: input.funding_goal ?? null,
  };
}

export function buildUiOpenFinanceSummaryFromConfig(
  config: UiOpenFinanceConfig,
  updatedAt: string | null = null
): UiOpenFinancePublicSummary {
  const totals = computeUiOpenFinanceTotals(config.cost_items);
  const fundingGoal = computeUiFundingGoalSummary(config.funding_goal, totals);
  const enabledPlatforms = config.platforms.filter((p) => p.enabled);
  const primary =
    config.primary_platform && enabledPlatforms.some((p) => p.platform === config.primary_platform)
      ? config.primary_platform
      : (enabledPlatforms[0]?.platform ?? null);

  return {
    page_title: config.page_title,
    nav_label: config.nav_label,
    supporter_message: config.supporter_message,
    currency: config.currency,
    visibility: config.visibility,
    platforms: enabledPlatforms.map((entry) => {
      const spec = UI_DONATION_PLATFORM_REGISTRY[entry.platform];
      return {
        platform: entry.platform,
        name: spec.name,
        url: entry.url,
        host: spec.canonicalHost,
        handle: entry.handle,
        label: entry.label,
        ...(entry.description ? { description: entry.description } : {}),
        is_primary: entry.platform === primary,
      };
    }),
    cost_items: config.cost_items
      .filter((item) => item.active !== false)
      .map((item) => ({
        id: item.id,
        label: item.label,
        category: item.category,
        cadence: item.cadence,
        amount_cents: item.amount_cents,
        monthly_equivalent_cents:
          item.cadence === 'monthly'
            ? item.amount_cents
            : item.cadence === 'annual'
              ? Math.round(item.amount_cents / 12)
              : 0,
        annual_equivalent_cents:
          item.cadence === 'monthly'
            ? item.amount_cents * 12
            : item.cadence === 'annual'
              ? item.amount_cents
              : 0,
        ...(item.vendor ? { vendor: item.vendor } : {}),
        ...(item.notes ? { notes: item.notes } : {}),
      })),
    totals,
    funding_goal: fundingGoal,
    updated_at: updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Expected non-empty string for ${field}`);
  }
  return value.trim();
}

function expectNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected non-negative integer for ${field}`);
  }
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean for ${field}`);
  }
  return value;
}

export function parseUiOpenFinanceSummary(raw: unknown): UiOpenFinancePublicSummary {
  if (!isRecord(raw)) {
    throw new Error('Expected JSON object for open-finance summary');
  }
  if (!isUiOpenFinanceCurrency(raw['currency'])) {
    throw new Error('Invalid currency in open-finance summary');
  }
  if (!isRecord(raw['visibility'])) {
    throw new Error('Expected visibility object');
  }
  if (!isRecord(raw['totals'])) {
    throw new Error('Expected totals object');
  }
  if (!Array.isArray(raw['platforms'])) {
    throw new Error('Expected platforms array');
  }
  if (!Array.isArray(raw['cost_items'])) {
    throw new Error('Expected cost_items array');
  }

  const platforms: UiOpenFinancePublicPlatform[] = raw['platforms'].map((entry, idx) => {
    if (!isRecord(entry) || !isUiDonationPlatformId(entry['platform'])) {
      throw new Error(`Invalid platform at platforms[${idx}]`);
    }
    const rawUrl = expectNonEmptyString(entry['url'], `platforms[${idx}].url`);
    const urlCheck = validateUiDonationPlatformUrl(entry['platform'], rawUrl);
    if (!urlCheck.ok) {
      throw new Error(`Unsafe donation URL at platforms[${idx}]: ${urlCheck.error}`);
    }
    const spec = UI_DONATION_PLATFORM_REGISTRY[entry['platform']];
    return {
      platform: entry['platform'],
      name: spec.name,
      url: urlCheck.url,
      host: urlCheck.host,
      handle: urlCheck.handle,
      label:
        typeof entry['label'] === 'string' && entry['label'].trim()
          ? entry['label'].trim()
          : spec.defaultCtaLabel,
      ...(typeof entry['description'] === 'string' && entry['description'].trim()
        ? { description: entry['description'].trim() }
        : {}),
      is_primary: expectBoolean(entry['is_primary'], `platforms[${idx}].is_primary`),
    };
  });

  const costItems: UiOpenFinancePublicCostItem[] = raw['cost_items'].map((entry, idx) => {
    if (!isRecord(entry)) {
      throw new Error(`Expected object at cost_items[${idx}]`);
    }
    if (!isUiOpenFinanceCostCategory(entry['category'])) {
      throw new Error(`Invalid category at cost_items[${idx}]`);
    }
    if (!isUiOpenFinanceCostCadence(entry['cadence'])) {
      throw new Error(`Invalid cadence at cost_items[${idx}]`);
    }
    return {
      id: expectNonEmptyString(entry['id'], `cost_items[${idx}].id`),
      label: expectNonEmptyString(entry['label'], `cost_items[${idx}].label`),
      category: entry['category'],
      cadence: entry['cadence'],
      amount_cents: expectNonNegativeInt(entry['amount_cents'], `cost_items[${idx}].amount_cents`),
      monthly_equivalent_cents: expectNonNegativeInt(
        entry['monthly_equivalent_cents'],
        `cost_items[${idx}].monthly_equivalent_cents`
      ),
      annual_equivalent_cents: expectNonNegativeInt(
        entry['annual_equivalent_cents'],
        `cost_items[${idx}].annual_equivalent_cents`
      ),
      ...(typeof entry['vendor'] === 'string' && entry['vendor'].trim()
        ? { vendor: entry['vendor'].trim() }
        : {}),
      ...(typeof entry['notes'] === 'string' && entry['notes'].trim()
        ? { notes: entry['notes'].trim() }
        : {}),
    };
  });

  let fundingGoal: UiOpenFinanceFundingGoalSummary | null = null;
  if (raw['funding_goal'] !== null && raw['funding_goal'] !== undefined) {
    if (!isRecord(raw['funding_goal'])) {
      throw new Error('Invalid funding_goal object');
    }
    const period = raw['funding_goal']['period'];
    if (period !== 'monthly' && period !== 'annual') {
      throw new Error('Invalid funding_goal.period');
    }
    fundingGoal = {
      period,
      target_cents: expectNonNegativeInt(raw['funding_goal']['target_cents'], 'funding_goal.target_cents'),
      received_cents: expectNonNegativeInt(
        raw['funding_goal']['received_cents'],
        'funding_goal.received_cents'
      ),
      remaining_cents: expectNonNegativeInt(
        raw['funding_goal']['remaining_cents'],
        'funding_goal.remaining_cents'
      ),
      progress_percent: expectNonNegativeInt(
        raw['funding_goal']['progress_percent'],
        'funding_goal.progress_percent'
      ),
      raw_percent: expectNonNegativeInt(raw['funding_goal']['raw_percent'], 'funding_goal.raw_percent'),
      ...(typeof raw['funding_goal']['label'] === 'string' && raw['funding_goal']['label'].trim()
        ? { label: raw['funding_goal']['label'].trim() }
        : {}),
      ...(typeof raw['funding_goal']['as_of_date'] === 'string' && raw['funding_goal']['as_of_date'].trim()
        ? { as_of_date: raw['funding_goal']['as_of_date'].trim() }
        : {}),
    };
  }

  return {
    page_title: expectNonEmptyString(raw['page_title'], 'page_title'),
    nav_label: expectNonEmptyString(raw['nav_label'], 'nav_label'),
    supporter_message: typeof raw['supporter_message'] === 'string' ? raw['supporter_message'] : '',
    currency: raw['currency'],
    visibility: {
      show_support_page: expectBoolean(
        raw['visibility']['show_support_page'],
        'visibility.show_support_page'
      ),
      show_in_nav: expectBoolean(raw['visibility']['show_in_nav'], 'visibility.show_in_nav'),
      show_in_footer: expectBoolean(raw['visibility']['show_in_footer'], 'visibility.show_in_footer'),
    },
    platforms,
    cost_items: costItems,
    totals: {
      recurring_monthly_direct_cents: expectNonNegativeInt(
        raw['totals']['recurring_monthly_direct_cents'],
        'totals.recurring_monthly_direct_cents'
      ),
      recurring_annual_direct_cents: expectNonNegativeInt(
        raw['totals']['recurring_annual_direct_cents'],
        'totals.recurring_annual_direct_cents'
      ),
      monthly_operating_cents: expectNonNegativeInt(
        raw['totals']['monthly_operating_cents'],
        'totals.monthly_operating_cents'
      ),
      annual_operating_cents: expectNonNegativeInt(
        raw['totals']['annual_operating_cents'],
        'totals.annual_operating_cents'
      ),
      one_time_cents: expectNonNegativeInt(raw['totals']['one_time_cents'], 'totals.one_time_cents'),
      first_year_total_cents: expectNonNegativeInt(
        raw['totals']['first_year_total_cents'],
        'totals.first_year_total_cents'
      ),
      active_item_count: expectNonNegativeInt(raw['totals']['active_item_count'], 'totals.active_item_count'),
    },
    funding_goal: fundingGoal,
    updated_at: typeof raw['updated_at'] === 'string' && raw['updated_at'] ? raw['updated_at'] : null,
  };
}

export function parseUiOpenFinanceAdminConfig(raw: unknown): UiOpenFinanceAdminConfigPayload {
  if (!isRecord(raw) || !isRecord(raw['config'])) {
    throw new Error('Expected JSON object with config for admin open-finance payload');
  }
  const summary = parseUiOpenFinanceSummary(raw['summary']);
  const rawCfg = raw['config'];
  if (!isUiOpenFinanceCurrency(rawCfg['currency'])) {
    throw new Error('Invalid config.currency');
  }
  if (!isRecord(rawCfg['visibility'])) {
    throw new Error('Expected config.visibility');
  }
  if (!Array.isArray(rawCfg['platforms']) || !Array.isArray(rawCfg['cost_items'])) {
    throw new Error('Expected config.platforms and config.cost_items arrays');
  }

  const platforms: UiOpenFinancePlatformInput[] = rawCfg['platforms'].map((p, idx) => {
    if (!isRecord(p) || !isUiDonationPlatformId(p['platform'])) {
      throw new Error(`Invalid config.platforms[${idx}]`);
    }
    return {
      platform: p['platform'],
      url: expectNonEmptyString(p['url'], `config.platforms[${idx}].url`),
      label: typeof p['label'] === 'string' ? p['label'] : undefined,
      description: typeof p['description'] === 'string' ? p['description'] : undefined,
      enabled: typeof p['enabled'] === 'boolean' ? p['enabled'] : true,
    };
  });

  const costItems: UiOpenFinanceCostItem[] = rawCfg['cost_items'].map((item, idx) => {
    if (
      !isRecord(item) ||
      !isUiOpenFinanceCostCategory(item['category']) ||
      !isUiOpenFinanceCostCadence(item['cadence'])
    ) {
      throw new Error(`Invalid config.cost_items[${idx}]`);
    }
    return {
      id: expectNonEmptyString(item['id'], `config.cost_items[${idx}].id`),
      label: expectNonEmptyString(item['label'], `config.cost_items[${idx}].label`),
      category: item['category'],
      cadence: item['cadence'],
      amount_cents: expectNonNegativeInt(item['amount_cents'], `config.cost_items[${idx}].amount_cents`),
      ...(typeof item['vendor'] === 'string' && item['vendor'].trim()
        ? { vendor: item['vendor'].trim() }
        : {}),
      ...(typeof item['notes'] === 'string' && item['notes'].trim() ? { notes: item['notes'].trim() } : {}),
      active: typeof item['active'] === 'boolean' ? item['active'] : true,
    };
  });

  let fundingGoal: UiOpenFinanceFundingGoal | null = null;
  if (rawCfg['funding_goal'] !== null && rawCfg['funding_goal'] !== undefined) {
    if (!isRecord(rawCfg['funding_goal'])) {
      throw new Error('Invalid config.funding_goal');
    }
    const period = rawCfg['funding_goal']['period'];
    if (period !== 'monthly' && period !== 'annual') {
      throw new Error('Invalid config.funding_goal.period');
    }
    fundingGoal = {
      enabled: expectBoolean(rawCfg['funding_goal']['enabled'], 'config.funding_goal.enabled'),
      period,
      target_cents: expectNonNegativeInt(
        rawCfg['funding_goal']['target_cents'],
        'config.funding_goal.target_cents'
      ),
      received_cents: expectNonNegativeInt(
        rawCfg['funding_goal']['received_cents'],
        'config.funding_goal.received_cents'
      ),
      ...(typeof rawCfg['funding_goal']['label'] === 'string' && rawCfg['funding_goal']['label'].trim()
        ? { label: rawCfg['funding_goal']['label'].trim() }
        : {}),
      ...(typeof rawCfg['funding_goal']['as_of_date'] === 'string' &&
      rawCfg['funding_goal']['as_of_date'].trim()
        ? { as_of_date: rawCfg['funding_goal']['as_of_date'].trim() }
        : {}),
    };
  }

  const primaryPlatform =
    rawCfg['primary_platform'] === null || rawCfg['primary_platform'] === undefined
      ? null
      : isUiDonationPlatformId(rawCfg['primary_platform'])
        ? rawCfg['primary_platform']
        : (() => {
            throw new Error('Invalid config.primary_platform');
          })();

  const config = normalizeUiOpenFinanceConfig({
    page_title: expectNonEmptyString(rawCfg['page_title'], 'config.page_title'),
    nav_label: expectNonEmptyString(rawCfg['nav_label'], 'config.nav_label'),
    supporter_message: typeof rawCfg['supporter_message'] === 'string' ? rawCfg['supporter_message'] : '',
    currency: rawCfg['currency'],
    visibility: {
      show_support_page: expectBoolean(
        rawCfg['visibility']['show_support_page'],
        'config.visibility.show_support_page'
      ),
      show_in_nav: expectBoolean(rawCfg['visibility']['show_in_nav'], 'config.visibility.show_in_nav'),
      show_in_footer: expectBoolean(
        rawCfg['visibility']['show_in_footer'],
        'config.visibility.show_in_footer'
      ),
    },
    primary_platform: primaryPlatform,
    platforms,
    cost_items: costItems,
    funding_goal: fundingGoal,
  });

  return {
    config,
    summary,
    updated_at: typeof raw['updated_at'] === 'string' && raw['updated_at'] ? raw['updated_at'] : null,
    updated_by: typeof raw['updated_by'] === 'string' && raw['updated_by'] ? raw['updated_by'] : null,
    persistence_available:
      typeof raw['persistence_available'] === 'boolean' ? raw['persistence_available'] : true,
  };
}
