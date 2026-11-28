import { describe, expect, it } from 'vitest';
import {
  buildUiDonationPlatformUrl,
  buildUiOpenFinanceSummaryFromConfig,
  computeUiFundingGoalSummary,
  computeUiOpenFinanceTotals,
  formatCentsToDecimalInput,
  formatCostCadenceLabel,
  formatCostCategoryLabel,
  formatUiCurrencyCents,
  normalizeUiOpenFinanceConfig,
  parseDecimalMoneyToCents,
  parseUiOpenFinanceAdminConfig,
  parseUiOpenFinanceSummary,
  UI_OPEN_FINANCE_COST_CADENCES,
  UI_OPEN_FINANCE_COST_CATEGORIES,
  validateUiDonationPlatformUrl,
} from './openFinanceModel.js';

describe('openFinanceModel URL allowlist and money parsing', () => {
  it('validates and canonicalizes allowlisted HTTPS platform URLs and handles', () => {
    expect(
      validateUiDonationPlatformUrl('github_sponsors', 'https://github.com/sponsors/alder-org/')
    ).toEqual({
      ok: true,
      url: 'https://github.com/sponsors/alder-org',
      handle: 'alder-org',
      host: 'github.com',
    });
    expect(buildUiDonationPlatformUrl('buy_me_a_coffee', 'alderarchive')).toEqual({
      ok: true,
      url: 'https://buymeacoffee.com/alderarchive',
      handle: 'alderarchive',
      host: 'buymeacoffee.com',
    });
    expect(buildUiDonationPlatformUrl('paypal_me', 'https://www.paypal.me/alderarchive')).toEqual({
      ok: true,
      url: 'https://paypal.me/alderarchive',
      handle: 'alderarchive',
      host: 'paypal.me',
    });
  });

  it('rejects javascript:, data:, http:, credentials, custom ports, query/hash, traversal, and wrong hosts', () => {
    const badCases = [
      ['github_sponsors', ''],
      ['github_sponsors', 'bad url with spaces'],
      ['github_sponsors', 'not-a-url'],
      ['github_sponsors', 'javascript:alert(1)'],
      ['ko_fi', 'data:text/html,hi'],
      ['ko_fi', 'http://ko-fi.com/alderarchive'],
      ['ko_fi', 'https://user:pass@ko-fi.com/alderarchive'],
      ['ko_fi', 'https://ko-fi.com:444/alderarchive'],
      ['ko_fi', 'https://ko-fi.com/alderarchive?ref=x'],
      ['ko_fi', 'https://ko-fi.com/alderarchive#section'],
      ['ko_fi', 'https://evil.example/alderarchive'],
      ['ko_fi', 'https://ko-fi.com/alder%2farchive'],
      ['ko_fi', 'https://ko-fi.com/..'],
      ['ko_fi', 'https://ko-fi.com/a/b'],
      ['github_sponsors', 'https://github.com/alder'],
      ['github_sponsors', 'https://github.com/sponsors/bad--name'],
      ['stripe', 'https://buy.stripe.com/abc'],
    ] as const;

    for (const [platform, raw] of badCases) {
      expect(validateUiDonationPlatformUrl(platform, raw).ok).toBe(false);
    }

    expect(buildUiDonationPlatformUrl('ko_fi', '').ok).toBe(false);
    expect(buildUiDonationPlatformUrl('ko_fi', 'bad/handle').ok).toBe(false);
  });

  it('parses decimal money inputs to exact integer cents without floating-point errors', () => {
    expect(parseDecimalMoneyToCents('19.99')).toBe(1999);
    expect(parseDecimalMoneyToCents('0.1')).toBe(10);
    expect(parseDecimalMoneyToCents('1,250')).toBe(125000);
    expect(parseDecimalMoneyToCents('0')).toBe(0);
    expect(parseDecimalMoneyToCents('')).toBeNull();
    expect(parseDecimalMoneyToCents('-5.00')).toBeNull();
    expect(parseDecimalMoneyToCents('12.345')).toBeNull();
    expect(parseDecimalMoneyToCents('999999999')).toBeNull();

    expect(formatCentsToDecimalInput(1999)).toBe('19.99');
    expect(formatCentsToDecimalInput(-1)).toBe('0.00');
    expect(formatUiCurrencyCents(2450, 'USD')).toBe('$24.50');
    expect(formatUiCurrencyCents(-50, 'EUR')).toBe('-€0.50');
  });

  it('computes exact totals, labels, and funding goal summaries', () => {
    for (const cat of UI_OPEN_FINANCE_COST_CATEGORIES) {
      expect(formatCostCategoryLabel(cat).length).toBeGreaterThan(3);
    }
    for (const cad of UI_OPEN_FINANCE_COST_CADENCES) {
      expect(formatCostCadenceLabel(cad).length).toBeGreaterThan(3);
    }

    const totals = computeUiOpenFinanceTotals([
      { id: 'dom', label: 'Domain', category: 'domain', cadence: 'annual', amount_cents: 1200, active: true },
      {
        id: 'host',
        label: 'Workers',
        category: 'hosting',
        cadence: 'monthly',
        amount_cents: 500,
        active: true,
      },
      {
        id: 'scan',
        label: 'Scan Fee',
        category: 'other',
        cadence: 'one_time',
        amount_cents: 3000,
        active: true,
      },
      {
        id: 'off',
        label: 'Inactive',
        category: 'storage',
        cadence: 'monthly',
        amount_cents: 900,
        active: false,
      },
    ]);
    expect(totals.annual_operating_cents).toBe(7200);
    expect(totals.monthly_operating_cents).toBe(600);
    expect(totals.one_time_cents).toBe(3000);
    expect(totals.first_year_total_cents).toBe(10200);

    const goal = computeUiFundingGoalSummary(
      { enabled: true, period: 'annual', target_cents: 0, received_cents: 3600, label: 'Annual Goal' },
      totals
    );
    expect(goal?.progress_percent).toBe(50);
    expect(goal?.remaining_cents).toBe(3600);
    expect(computeUiFundingGoalSummary(null, totals)).toBeNull();
  });

  it('rejects tampered non-allowlisted donation URLs when parsing API responses', () => {
    const cfg = normalizeUiOpenFinanceConfig({
      platforms: [{ platform: 'github_sponsors', handle: 'alder-archive' }],
      cost_items: [
        {
          id: 'r2',
          label: 'R2',
          category: 'storage',
          cadence: 'monthly',
          amount_cents: 500,
          vendor: 'Cloudflare',
        },
      ],
      funding_goal: {
        enabled: true,
        period: 'monthly',
        target_cents: 500,
        received_cents: 250,
        as_of_date: '2026-11-27',
      },
    });
    const summary = buildUiOpenFinanceSummaryFromConfig(cfg, '2026-11-27T12:00:00.000Z');
    const parsedSummary = parseUiOpenFinanceSummary(summary);
    expect(parsedSummary.platforms[0]?.url).toBe('https://github.com/sponsors/alder-archive');

    const parsedAdmin = parseUiOpenFinanceAdminConfig({
      config: cfg,
      summary,
      updated_at: '2026-11-27T12:00:00.000Z',
      updated_by: 'steward@archive.example',
      persistence_available: true,
    });
    expect(parsedAdmin.updated_by).toBe('steward@archive.example');

    expect(() =>
      parseUiOpenFinanceSummary({
        ...summary,
        platforms: [{ ...summary.platforms[0], url: 'javascript:alert(1)' }],
      })
    ).toThrow(/Unsafe donation URL/);

    expect(() => parseUiOpenFinanceSummary(null)).toThrow();
    expect(() => parseUiOpenFinanceAdminConfig({})).toThrow();
    expect(() =>
      normalizeUiOpenFinanceConfig({
        platforms: [
          { platform: 'ko_fi', handle: 'a' },
          { platform: 'ko_fi', handle: 'b' },
        ],
      })
    ).toThrow(RangeError);
    expect(() =>
      normalizeUiOpenFinanceConfig({
        primary_platform: 'stripe',
        platforms: [{ platform: 'ko_fi', handle: 'alder' }],
      })
    ).toThrow(RangeError);
  });

  it('handles open-finance normalization, summary fallbacks, and strict boundary parser errors', () => {
    expect(formatUiCurrencyCents(12.6)).toBe('$0.13');
    const emptyTotals = computeUiOpenFinanceTotals([]);
    expect(
      computeUiFundingGoalSummary(
        { enabled: true, period: 'monthly', target_cents: 0, received_cents: 100 },
        emptyTotals
      )
    ).toEqual({
      period: 'monthly',
      target_cents: 0,
      received_cents: 100,
      remaining_cents: 0,
      progress_percent: 0,
      raw_percent: 0,
    });

    const defaults = normalizeUiOpenFinanceConfig();
    expect(defaults.primary_platform).toBeNull();
    expect(defaults.currency).toBe('USD');
    expect(defaults.funding_goal).toBeNull();

    expect(() => normalizeUiOpenFinanceConfig({ platforms: [{ platform: 'ko_fi' }] })).toThrow(RangeError);
    expect(() =>
      normalizeUiOpenFinanceConfig({ platforms: [{ platform: 'ko_fi', url: 'https://evil.example/x' }] })
    ).toThrow(RangeError);
    expect(() =>
      normalizeUiOpenFinanceConfig({
        cost_items: [{ id: '   ', label: 'X', category: 'other', cadence: 'one_time', amount_cents: 100 }],
      })
    ).toThrow(RangeError);
    expect(() =>
      normalizeUiOpenFinanceConfig({
        cost_items: [{ id: 'a', label: 'X', category: 'other', cadence: 'one_time', amount_cents: -5 }],
      })
    ).toThrow(RangeError);

    const richCfg = normalizeUiOpenFinanceConfig({
      supporter_message: '  Custom note  ',
      platforms: [
        {
          platform: 'ko_fi',
          url: 'https://ko-fi.com/alderarchive',
          description: 'Coffee support',
          enabled: false,
        },
        {
          platform: 'buy_me_a_coffee',
          handle: 'alderarchive',
          description: 'One-time gift',
        },
      ],
      cost_items: [
        {
          id: 'dom',
          label: '  ',
          category: 'domain',
          cadence: 'annual',
          amount_cents: 1200,
          notes: 'Yearly',
        },
        { id: 'scan', label: 'Scanner', category: 'other', cadence: 'one_time', amount_cents: 5000 },
      ],
    });
    expect(richCfg.cost_items[0]?.label).toBe('dom');
    expect(richCfg.cost_items[0]?.notes).toBe('Yearly');

    // Summary builder handles stale primary_platform pointing to disabled entry and empty enabled list
    const stalePrimarySummary = buildUiOpenFinanceSummaryFromConfig({
      ...richCfg,
      primary_platform: 'ko_fi',
    });
    expect(stalePrimarySummary.platforms[0]?.platform).toBe('buy_me_a_coffee');
    expect(stalePrimarySummary.platforms[0]?.is_primary).toBe(true);
    expect(stalePrimarySummary.platforms[0]?.description).toBe('One-time gift');
    expect(stalePrimarySummary.cost_items[0]?.monthly_equivalent_cents).toBe(100);
    expect(stalePrimarySummary.cost_items[1]?.annual_equivalent_cents).toBe(0);

    const noEnabledSummary = buildUiOpenFinanceSummaryFromConfig({
      ...richCfg,
      platforms: [],
      primary_platform: null,
    });
    expect(noEnabledSummary.platforms).toEqual([]);

    // parseUiOpenFinanceSummary optional fields and error guards
    const parsedWithOptionals = parseUiOpenFinanceSummary({
      ...stalePrimarySummary,
      supporter_message: 123,
      platforms: [{ ...stalePrimarySummary.platforms[0], label: '   ' }],
      funding_goal: {
        period: 'annual',
        target_cents: 1000,
        received_cents: 500,
        remaining_cents: 500,
        progress_percent: 50,
        raw_percent: 50,
        label: 'Annual Goal',
      },
      updated_at: '',
    });
    expect(parsedWithOptionals.supporter_message).toBe('');
    expect(parsedWithOptionals.platforms[0]?.label).toBe('Buy Me a Coffee');
    expect(parsedWithOptionals.funding_goal?.label).toBe('Annual Goal');
    expect(parsedWithOptionals.updated_at).toBeNull();

    const invalidSummaries: unknown[] = [
      { ...stalePrimarySummary, currency: 'JPY' },
      { ...stalePrimarySummary, visibility: null },
      { ...stalePrimarySummary, totals: null },
      { ...stalePrimarySummary, platforms: 'bad' },
      { ...stalePrimarySummary, cost_items: 'bad' },
      { ...stalePrimarySummary, platforms: [{ platform: 'bogus' }] },
      { ...stalePrimarySummary, platforms: [{ ...stalePrimarySummary.platforms[0], is_primary: 'yes' }] },
      { ...stalePrimarySummary, cost_items: [null] },
      { ...stalePrimarySummary, cost_items: [{ ...stalePrimarySummary.cost_items[0], category: 'bad' }] },
      { ...stalePrimarySummary, cost_items: [{ ...stalePrimarySummary.cost_items[0], cadence: 'weekly' }] },
      { ...stalePrimarySummary, cost_items: [{ ...stalePrimarySummary.cost_items[0], amount_cents: -1 }] },
      { ...stalePrimarySummary, page_title: '   ' },
      { ...stalePrimarySummary, funding_goal: 'bad' },
      { ...stalePrimarySummary, funding_goal: { period: 'weekly' } },
    ];
    for (const bad of invalidSummaries) {
      expect(() => parseUiOpenFinanceSummary(bad)).toThrow();
    }

    // parseUiOpenFinanceAdminConfig optional fields and error guards
    const validAdminBase = {
      config: {
        ...richCfg,
        supporter_message: 42,
        primary_platform: null,
        platforms: [{ platform: 'buy_me_a_coffee', url: 'https://buymeacoffee.com/alderarchive' }],
        cost_items: [
          {
            id: 'n1',
            label: 'Notes item',
            category: 'other',
            cadence: 'one_time',
            amount_cents: 100,
            notes: 'ok',
          },
        ],
        funding_goal: {
          enabled: true,
          period: 'annual',
          target_cents: 1000,
          received_cents: 250,
          label: 'Yearly Goal',
        },
      },
      summary: stalePrimarySummary,
      updated_at: null,
      updated_by: null,
      persistence_available: 'yes',
    };
    const parsedAdmin = parseUiOpenFinanceAdminConfig(validAdminBase);
    expect(parsedAdmin.config.supporter_message).toBe('');
    expect(parsedAdmin.config.funding_goal?.label).toBe('Yearly Goal');
    expect(parsedAdmin.updated_at).toBeNull();
    expect(parsedAdmin.updated_by).toBeNull();
    expect(parsedAdmin.persistence_available).toBe(true);

    const parsedAdminNoGoal = parseUiOpenFinanceAdminConfig({
      ...validAdminBase,
      config: { ...validAdminBase.config, funding_goal: null },
    });
    expect(parsedAdminNoGoal.config.funding_goal).toBeNull();

    const invalidAdmins: unknown[] = [
      { ...validAdminBase, config: { ...validAdminBase.config, currency: 'JPY' } },
      { ...validAdminBase, config: { ...validAdminBase.config, visibility: null } },
      { ...validAdminBase, config: { ...validAdminBase.config, platforms: 'bad' } },
      { ...validAdminBase, config: { ...validAdminBase.config, platforms: [{ platform: 'bad' }] } },
      { ...validAdminBase, config: { ...validAdminBase.config, cost_items: [{ category: 'bad' }] } },
      { ...validAdminBase, config: { ...validAdminBase.config, funding_goal: 'bad' } },
      { ...validAdminBase, config: { ...validAdminBase.config, funding_goal: { period: 'weekly' } } },
      { ...validAdminBase, config: { ...validAdminBase.config, primary_platform: 'bogus' } },
    ];
    for (const bad of invalidAdmins) {
      expect(() => parseUiOpenFinanceAdminConfig(bad)).toThrow();
    }
  });
});
