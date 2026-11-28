import { parseKinloomConfig } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import type { FixedClock } from '../adapters/systemClock.js';
import { createKinloomServer } from '../http/router.js';
import { getSessionCookieName, signSessionToken } from '../http/session.js';
import {
  buildDonationPlatformUrl,
  buildOpenFinancePublicSummary,
  computeFundingGoalSummary,
  computeOpenFinanceTotals,
  createDefaultOpenFinanceConfig,
  createOpenFinancePlugin,
  type DONATION_PLATFORM_IDS,
  formatCurrencyCents,
  OPEN_FINANCE_ADMIN_ROUTE,
  OPEN_FINANCE_PLUGIN_ID,
  OPEN_FINANCE_PUBLIC_ROUTE,
  type OpenFinanceAdminConfigResponse,
  type OpenFinancePublicSummary,
  openFinanceConfigToSettingsValues,
  parseOpenFinanceConfig,
  settingsValuesToOpenFinanceConfig,
  validateDonationPlatformUrl,
  validateOpenFinanceConfig,
} from './openFinance.js';

const SESSION_SECRET = 'test-open-finance-secret-at-least-32-chars!!';

const siteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Family Archive',
    familyName: 'Alder Family',
    gedcomSourceName: 'ALDER_OPEN_FINANCE_TEST',
  },
});

async function createSessionCookie(params: {
  clock: FixedClock;
  email: string;
  role: 'admin' | 'editor';
  displayName: string;
}): Promise<string> {
  const token = await signSessionToken({
    secret: SESSION_SECRET,
    clock: params.clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email: params.email,
      display_name: params.displayName,
      role: params.role,
    },
  });
  return `${getSessionCookieName(true)}=${token}`;
}

describe('open-finance URL allowlist and handle validation', () => {
  it('accepts and canonicalizes valid HTTPS URLs across all 6 supported platforms', () => {
    const cases = [
      [
        'github_sponsors',
        'https://github.com/sponsors/alder-archive/',
        'https://github.com/sponsors/alder-archive',
        'alder-archive',
      ],
      [
        'buy_me_a_coffee',
        'https://www.buymeacoffee.com/alder.archive',
        'https://buymeacoffee.com/alder.archive',
        'alder.archive',
      ],
      ['ko_fi', 'https://www.ko-fi.com/alder_archive/', 'https://ko-fi.com/alder_archive', 'alder_archive'],
      [
        'open_collective',
        'https://www.opencollective.com/alder-family-archive',
        'https://opencollective.com/alder-family-archive',
        'alder-family-archive',
      ],
      [
        'stripe',
        'https://buy.stripe.com/test_aEU000000000',
        'https://buy.stripe.com/test_aEU000000000',
        'test_aEU000000000',
      ],
      ['paypal_me', 'https://www.paypal.me/alderArchive/', 'https://paypal.me/alderArchive', 'alderArchive'],
    ] as const;

    for (const [platform, input, expectedUrl, expectedHandle] of cases) {
      const result = validateDonationPlatformUrl(platform, input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url).toBe(expectedUrl);
        expect(result.handle).toBe(expectedHandle);
      }
    }
  });

  it('builds canonical allowlisted URLs from bare handles and rejects unsafe handle characters', () => {
    const built = buildDonationPlatformUrl('github_sponsors', 'alder-steward');
    expect(built).toEqual({
      ok: true,
      url: 'https://github.com/sponsors/alder-steward',
      handle: 'alder-steward',
      host: 'github.com',
    });

    const passthrough = buildDonationPlatformUrl('ko_fi', 'https://ko-fi.com/alderarchive');
    expect(passthrough.ok).toBe(true);

    expect(buildDonationPlatformUrl('github_sponsors', '').ok).toBe(false);
    expect(buildDonationPlatformUrl('github_sponsors', 'foo/bar').ok).toBe(false);
    expect(buildDonationPlatformUrl('github_sponsors', '@alder').ok).toBe(false);
    expect(buildDonationPlatformUrl('github_sponsors', 'javascript:alert(1)').ok).toBe(false);
  });

  it('rejects javascript:, data:, http:, credentials, custom ports, query/hash, arbitrary hosts, traversal, and malformed handles', () => {
    const rejected: readonly [(typeof DONATION_PLATFORM_IDS)[number], string][] = [
      ['github_sponsors', ''],
      ['github_sponsors', 'not a url'],
      ['github_sponsors', 'https://github.com/sponsors/alder archive'],
      ['github_sponsors', 'https://github.com/sponsors/alder\\archive'],
      ['github_sponsors', 'javascript:alert(1)'],
      ['buy_me_a_coffee', 'data:text/html,<script>alert(1)</script>'],
      ['ko_fi', 'http://ko-fi.com/alderarchive'],
      ['github_sponsors', 'https://user:pass@github.com/sponsors/alder'],
      ['github_sponsors', 'https://github.com:8443/sponsors/alder'],
      ['github_sponsors', 'https://github.com/sponsors/alder?amount=50'],
      ['github_sponsors', 'https://github.com/sponsors/alder#top'],
      ['github_sponsors', 'https://evil.example/sponsors/alder'],
      ['github_sponsors', 'https://github.com.evil.example/sponsors/alder'],
      ['github_sponsors', 'https://github.com/alder'],
      ['github_sponsors', 'https://github.com/sponsors/alder/extra'],
      ['github_sponsors', 'https://github.com/sponsors/alder--bad'],
      ['github_sponsors', 'https://github.com/sponsors/-leading'],
      ['buy_me_a_coffee', 'https://buymeacoffee.com/alder/extra'],
      ['buy_me_a_coffee', 'https://buymeacoffee.com/alder%2fextra'],
      ['buy_me_a_coffee', 'https://buymeacoffee.com/..'],
      ['buy_me_a_coffee', 'https://buymeacoffee.com/bad..handle'],
      ['stripe', 'https://stripe.com/aEU000000000'],
      ['stripe', 'https://buy.stripe.com/short'],
      ['paypal_me', 'https://paypal.com/alderarchive'],
      ['open_collective', 'https://opencollective.com/bad_underscore'],
    ];

    for (const [platform, badUrl] of rejected) {
      const result = validateDonationPlatformUrl(platform, badUrl);
      expect(result.ok, `Expected rejection for ${platform}: ${badUrl}`).toBe(false);
    }
  });
});

describe('open-finance integer-cents cost math and config validation', () => {
  it('computes exact monthly, annual, and one-time totals in integer cents without float drift', () => {
    const totals = computeOpenFinanceTotals([
      {
        id: 'domain',
        label: 'Domain (.org)',
        category: 'domain',
        cadence: 'annual',
        amount_cents: 1000,
        active: true,
      },
      {
        id: 'dns',
        label: 'Secondary DNS',
        category: 'domain',
        cadence: 'annual',
        amount_cents: 1000,
        active: true,
      },
      {
        id: 'backup',
        label: 'Cold Backup',
        category: 'storage',
        cadence: 'annual',
        amount_cents: 1000,
        active: true,
      },
      {
        id: 'workers',
        label: 'Workers + R2',
        category: 'hosting',
        cadence: 'monthly',
        amount_cents: 500,
        active: true,
      },
      {
        id: 'scanner',
        label: 'Flatbed Scanner',
        category: 'other',
        cadence: 'one_time',
        amount_cents: 18500,
        active: true,
      },
      {
        id: 'retired',
        label: 'Old Hosting',
        category: 'hosting',
        cadence: 'monthly',
        amount_cents: 9900,
        active: false,
      },
    ]);

    expect(totals.recurring_monthly_direct_cents).toBe(500);
    expect(totals.recurring_annual_direct_cents).toBe(3000);
    expect(totals.annual_operating_cents).toBe(9000);
    expect(totals.monthly_operating_cents).toBe(750);
    expect(totals.one_time_cents).toBe(18500);
    expect(totals.first_year_total_cents).toBe(27500);
    expect(totals.active_item_count).toBe(5);
  });

  it('computes funding goal progress using explicit targets or computed operating cost targets', () => {
    const totals = computeOpenFinanceTotals([
      {
        id: 'host',
        label: 'Hosting',
        category: 'hosting',
        cadence: 'monthly',
        amount_cents: 2000,
        active: true,
      },
    ]);

    expect(computeFundingGoalSummary(null, totals)).toBeNull();
    expect(
      computeFundingGoalSummary(
        { enabled: false, period: 'annual', target_cents: 24000, received_cents: 12000 },
        totals
      )
    ).toBeNull();

    const autoAnnual = computeFundingGoalSummary(
      {
        enabled: true,
        period: 'annual',
        target_cents: 0,
        received_cents: 12000,
        label: '2026 Goal',
        as_of_date: '2026-11-01',
      },
      totals
    );
    expect(autoAnnual).toEqual({
      period: 'annual',
      target_cents: 24000,
      received_cents: 12000,
      remaining_cents: 12000,
      progress_percent: 50,
      raw_percent: 50,
      label: '2026 Goal',
      as_of_date: '2026-11-01',
    });

    const overfundedMonthly = computeFundingGoalSummary(
      { enabled: true, period: 'monthly', target_cents: 0, received_cents: 2500 },
      totals
    );
    expect(overfundedMonthly).toEqual({
      period: 'monthly',
      target_cents: 2000,
      received_cents: 2500,
      remaining_cents: 0,
      progress_percent: 100,
      raw_percent: 125,
    });
  });

  it('formats integer cents accurately across supported currencies', () => {
    expect(formatCurrencyCents(0, 'USD')).toBe('$0.00');
    expect(formatCurrencyCents(1250, 'USD')).toBe('$12.50');
    expect(formatCurrencyCents(1234567, 'EUR')).toBe('€12,345.67');
    expect(formatCurrencyCents(999, 'GBP')).toBe('£9.99');
    expect(formatCurrencyCents(4500, 'CAD')).toBe('CA$45.00');
    expect(formatCurrencyCents(-505, 'AUD')).toBe('-A$5.05');
  });

  it('rejects duplicate platforms, duplicate cost item IDs, invalid primary platform, and missing URLs', () => {
    const dupPlatforms = validateOpenFinanceConfig({
      platforms: [
        { platform: 'github_sponsors', handle: 'alder-archive' },
        { platform: 'github_sponsors', handle: 'alder-other' },
      ],
    });
    expect(dupPlatforms.ok).toBe(false);

    const missingUrl = validateOpenFinanceConfig({
      platforms: [{ platform: 'ko_fi' }],
    });
    expect(missingUrl.ok).toBe(false);

    const dupItems = validateOpenFinanceConfig({
      cost_items: [
        { id: 'item-1', label: 'A', category: 'domain', cadence: 'annual', amount_cents: 1000 },
        { id: 'item-1', label: 'B', category: 'hosting', cadence: 'monthly', amount_cents: 500 },
      ],
    });
    expect(dupItems.ok).toBe(false);

    const badPrimary = validateOpenFinanceConfig({
      primary_platform: 'stripe',
      platforms: [{ platform: 'github_sponsors', handle: 'alder-archive' }],
    });
    expect(badPrimary.ok).toBe(false);

    expect(() =>
      parseOpenFinanceConfig({ platforms: [{ platform: 'ko_fi', url: 'javascript:alert(1)' }] })
    ).toThrow(RangeError);
  });

  it('round-trips OpenFinanceConfig through PluginSettingsStore scalar values', () => {
    const config = parseOpenFinanceConfig({
      page_title: 'Archive Ledger',
      nav_label: 'Finance',
      supporter_message: 'Transparent hosting expenses.',
      currency: 'EUR',
      visibility: { show_support_page: true, show_in_nav: false, show_in_footer: true },
      primary_platform: 'buy_me_a_coffee',
      platforms: [
        { platform: 'github_sponsors', handle: 'alder-archive', label: 'Sponsor on GitHub' },
        { platform: 'buy_me_a_coffee', handle: 'alderarchive', description: 'One-time coffee' },
      ],
      cost_items: [
        {
          id: 'r2',
          label: 'Cloudflare R2',
          category: 'hosting',
          cadence: 'monthly',
          amount_cents: 450,
          vendor: 'Cloudflare',
        },
      ],
      funding_goal: { enabled: true, period: 'annual', target_cents: 10000, received_cents: 4000 },
    });

    const scalar = openFinanceConfigToSettingsValues(config);
    const restored = settingsValuesToOpenFinanceConfig(scalar, createDefaultOpenFinanceConfig());
    expect(restored).toEqual(config);

    const summary = buildOpenFinancePublicSummary(restored, '2026-11-27T12:00:00.000Z');
    expect(summary.platforms[1]?.is_primary).toBe(true);
    expect(summary.cost_items[0]?.annual_equivalent_cents).toBe(5400);
  });

  it('covers Zod schema errors, summary fallbacks, and partial PluginSettingsStore rehydration edge cases', () => {
    expect(formatCurrencyCents(12.6)).toBe('$0.13');
    const rootInvalid = validateOpenFinanceConfig('not-an-object');
    expect(rootInvalid.ok).toBe(false);
    if (!rootInvalid.ok) {
      expect(typeof rootInvalid.fieldErrors['_root']).toBe('string');
    }
    const multiIssue = validateOpenFinanceConfig({
      currency: 'JPY',
      cost_items: [{ id: 'bad id!', label: '', category: 'domain', cadence: 'annual', amount_cents: -1 }],
    });
    expect(multiIssue.ok).toBe(false);

    const zeroGoal = computeFundingGoalSummary(
      { enabled: true, period: 'annual', target_cents: 0, received_cents: 500 },
      computeOpenFinanceTotals([])
    );
    expect(zeroGoal?.raw_percent).toBe(0);

    const notedConfig = parseOpenFinanceConfig({
      platforms: [
        { platform: 'ko_fi', handle: 'alderarchive', description: 'Tip jar', enabled: false },
        { platform: 'buy_me_a_coffee', handle: 'alderarchive', description: 'Coffee' },
      ],
      cost_items: [
        {
          id: 'scan',
          label: 'Scanner',
          category: 'other',
          cadence: 'one_time',
          amount_cents: 2500,
          notes: 'One-time flatbed purchase',
        },
        {
          id: 'dom',
          label: 'Domain',
          category: 'domain',
          cadence: 'annual',
          amount_cents: 1200,
        },
      ],
      funding_goal: {
        enabled: true,
        period: 'annual',
        target_cents: 5000,
        received_cents: 1000,
        label: 'Annual Hosting',
      },
    });
    expect(notedConfig.cost_items[0]?.notes).toBe('One-time flatbed purchase');
    expect(notedConfig.funding_goal?.label).toBe('Annual Hosting');

    const fallbackPrimarySummary = buildOpenFinancePublicSummary(
      { ...notedConfig, primary_platform: 'ko_fi' },
      null
    );
    expect(fallbackPrimarySummary.platforms[0]?.platform).toBe('buy_me_a_coffee');
    expect(fallbackPrimarySummary.platforms[0]?.is_primary).toBe(true);
    expect(fallbackPrimarySummary.cost_items[0]?.monthly_equivalent_cents).toBe(0);
    expect(fallbackPrimarySummary.cost_items[0]?.annual_equivalent_cents).toBe(0);
    expect(fallbackPrimarySummary.cost_items[0]?.notes).toBe('One-time flatbed purchase');
    expect(fallbackPrimarySummary.cost_items[1]?.monthly_equivalent_cents).toBe(100);

    const emptySummary = buildOpenFinancePublicSummary(
      { ...notedConfig, platforms: [], primary_platform: null },
      null
    );
    expect(emptySummary.platforms).toEqual([]);

    // Rehydration with fallback values when scalar keys are missing, invalid, or malformed JSON
    const fallbackCfg = notedConfig;
    const rehydratedFromBadScalars = settingsValuesToOpenFinanceConfig(
      {
        currency: 'JPY',
        page_title: '   ',
        nav_label: '',
        supporter_message: 42 as unknown as string,
        show_support_page: 'yes' as unknown as boolean,
        show_in_nav: 'yes' as unknown as boolean,
        show_in_footer: 'yes' as unknown as boolean,
        platform_order_json: '{bad json',
        cost_ledger_json: 'not-json',
        funding_goal_json: 'not-json',
        primary_platform: 'auto',
      },
      fallbackCfg
    );
    expect(rehydratedFromBadScalars.currency).toBe(fallbackCfg.currency);
    expect(rehydratedFromBadScalars.page_title).toBe(fallbackCfg.page_title);
    expect(rehydratedFromBadScalars.primary_platform).toBe('buy_me_a_coffee');
    expect(rehydratedFromBadScalars.platforms).toHaveLength(2);

    // Rehydration handles invalid platform entries in JSON, clearing an enabled platform URL, preserving disabled ones, and invalid primary
    const rehydratedMutations = settingsValuesToOpenFinanceConfig(
      {
        platform_order_json: JSON.stringify([
          { platform: 'bogus_platform', url: 'https://example.com/x' },
          { platform: 'ko_fi', url: 'https://ko-fi.com/alderarchive', enabled: false },
          { platform: 'buy_me_a_coffee', url: 'https://buymeacoffee.com/alderarchive', enabled: true },
        ]),
        kofi_url: '',
        buy_me_a_coffee_url: '',
        stripe_payment_link_url: 123 as unknown as string,
        primary_platform: 'ko_fi',
      },
      fallbackCfg
    );
    expect(rehydratedMutations.platforms.map((p) => p.platform)).toEqual(['ko_fi']);
    expect(rehydratedMutations.primary_platform).toBeNull();

    // Rehydration falls back to `fallbackCfg` when resulting merged config fails allowlist validation
    const rehydratedInvalidUrl = settingsValuesToOpenFinanceConfig(
      {
        github_sponsors_url: 'https://evil.example/sponsors/alder',
      },
      fallbackCfg
    );
    expect(rehydratedInvalidUrl).toEqual(fallbackCfg);
  });
});

describe('createOpenFinancePlugin server integration', () => {
  it('stays completely off by default with zero routes and zero plugin settings entries', async () => {
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = ports.clock;
    await ports.repository.upsertUser({
      email: 'steward@archive.example',
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'system:bootstrap',
      added_at: '2026-01-01T00:00:00.000Z',
      last_login_at: null,
    });
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: SESSION_SECRET,
      mode: 'public',
    });

    const adminCookie = await createSessionCookie({
      clock,
      email: 'steward@archive.example',
      role: 'admin',
      displayName: 'Archive Steward',
    });

    const publicRes = await server.fetch(new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}`));
    expect(publicRes.status).toBe(404);

    const adminRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(adminRes.status).toBe(404);

    const settingsRes = await server.fetch(
      new Request('https://archive.example/api/admin/plugin-settings', {
        headers: { cookie: adminCookie },
      })
    );
    expect(settingsRes.status).toBe(200);
    const settingsBody = (await settingsRes.json()) as { plugins: readonly { plugin_id: string }[] };
    expect(settingsBody.plugins.some((p) => p.plugin_id === OPEN_FINANCE_PLUGIN_ID)).toBe(false);
  });

  it('returns an inert disabled plugin when options.enabled is false', async () => {
    const disabled = createOpenFinancePlugin({ enabled: false });
    expect(disabled.status).toBe('disabled');
    expect(disabled.routes).toBeUndefined();
    expect(disabled.settingsSchema).toBeUndefined();
    expect(await disabled.getStatus?.()).toEqual({
      status: 'disabled',
      detail: 'Disabled via plugin options',
    });

    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, plugins: [disabled] },
      sessionSecret: SESSION_SECRET,
      mode: 'public',
    });

    const res = await server.fetch(new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}`));
    expect(res.status).toBe(404);
  });

  it('serves public summary, enforces admin RBAC and CSRF on mutations, persists config, and syncs #44 plugin settings', async () => {
    const plugin = createOpenFinancePlugin({
      config: {
        page_title: 'Alder Archive Open Finance',
        platforms: [
          { platform: 'github_sponsors', handle: 'alder-archive' },
          { platform: 'buy_me_a_coffee', handle: 'alderarchive' },
        ],
        primary_platform: 'github_sponsors',
        cost_items: [
          {
            id: 'domain',
            label: 'Archive Domain (.org)',
            category: 'domain',
            cadence: 'annual',
            amount_cents: 1200,
            vendor: 'Cloudflare',
          },
          {
            id: 'hosting',
            label: 'Workers + R2 + D1',
            category: 'hosting',
            cadence: 'monthly',
            amount_cents: 500,
            vendor: 'Cloudflare',
          },
        ],
      },
    });
    expect(await plugin.getStatus?.()).toEqual({
      status: 'active',
      detail: '2 platform(s), 2 cost item(s)',
    });

    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = ports.clock;
    await ports.repository.upsertUser({
      email: 'steward@archive.example',
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'system:bootstrap',
      added_at: '2026-01-01T00:00:00.000Z',
      last_login_at: null,
    });
    await ports.repository.upsertUser({
      email: 'editor@archive.example',
      display_name: 'Family Editor',
      role: 'editor',
      added_by: 'steward@archive.example',
      added_at: '2026-01-01T00:00:00.000Z',
      last_login_at: null,
    });

    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, plugins: [plugin] },
      sessionSecret: SESSION_SECRET,
      mode: 'public',
    });

    const adminCookie = await createSessionCookie({
      clock,
      email: 'steward@archive.example',
      role: 'admin',
      displayName: 'Archive Steward',
    });
    const editorCookie = await createSessionCookie({
      clock,
      email: 'editor@archive.example',
      role: 'editor',
      displayName: 'Family Editor',
    });

    // Public GET succeeds with exact totals, allowlisted URLs, no-cache header, and ETag revalidation
    const pubRes = await server.fetch(new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}`));
    expect(pubRes.status).toBe(200);
    expect(pubRes.headers.get('cache-control')).toBe('no-cache');
    const pubEtag = pubRes.headers.get('etag');
    expect(pubEtag).toMatch(/^"of-[0-9a-f]{24}"$/);
    const revalRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}`, {
        headers: { 'if-none-match': pubEtag ?? '' },
      })
    );
    expect(revalRes.status).toBe(304);
    expect(revalRes.headers.get('cache-control')).toBe('no-cache');
    const pubBody = (await pubRes.json()) as OpenFinancePublicSummary;
    expect(pubBody.page_title).toBe('Alder Archive Open Finance');
    expect(pubBody.totals.annual_operating_cents).toBe(7200);
    expect(pubBody.totals.monthly_operating_cents).toBe(600);
    expect(pubBody.platforms.map((p) => p.url)).toEqual([
      'https://github.com/sponsors/alder-archive',
      'https://buymeacoffee.com/alderarchive',
    ]);
    expect(pubBody.platforms[0]?.is_primary).toBe(true);

    // Extra subpath returns 404
    const extraRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}/extra`)
    );
    expect(extraRes.status).toBe(404);

    // RBAC on admin endpoints: anonymous -> 401, editor -> 403
    const anonAdminRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`)
    );
    expect(anonAdminRes.status).toBe(401);

    const editorAdminRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        headers: { cookie: editorCookie },
      })
    );
    expect(editorAdminRes.status).toBe(403);

    // Cross-origin CSRF protection on PUT -> 403
    const csrfRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      })
    );
    expect(csrfRes.status).toBe(403);

    // Malformed JSON -> 400
    const badJsonRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: '{invalid',
      })
    );
    expect(badJsonRes.status).toBe(400);

    // Invalid javascript: donation URL -> 422 VALIDATION_ERROR with field_errors
    const badUrlRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          platforms: [{ platform: 'ko_fi', url: 'javascript:alert(1)' }],
        }),
      })
    );
    expect(badUrlRes.status).toBe(422);
    const badUrlBody = (await badUrlRes.json()) as {
      error: { code: string; details?: { field_errors?: Record<string, string> } };
    };
    expect(badUrlBody.error.code).toBe('VALIDATION_ERROR');
    expect(badUrlBody.error.details?.field_errors?.['platforms.0.url']).toContain('https://');

    // Valid admin PUT saves to PluginSettingsStore and updates public summary
    const saveRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          page_title: 'Updated Archive Costs',
          nav_label: 'Fund Archive',
          supporter_message: 'Help keep family records online.',
          currency: 'USD',
          visibility: { show_support_page: true, show_in_nav: true, show_in_footer: false },
          primary_platform: 'open_collective',
          platforms: [
            { platform: 'open_collective', handle: 'alder-collective', label: 'Back on Open Collective' },
            { platform: 'stripe', url: 'https://buy.stripe.com/test_abc12345' },
          ],
          cost_items: [
            { id: 'r2', label: 'Cloudflare R2', category: 'storage', cadence: 'monthly', amount_cents: 1000 },
            {
              id: 'archives',
              label: 'Archival Newspaper Sub',
              category: 'archival_subscriptions',
              cadence: 'annual',
              amount_cents: 12000,
            },
          ],
          funding_goal: {
            enabled: true,
            period: 'annual',
            target_cents: 24000,
            received_cents: 6000,
            as_of_date: '2026-11-27',
          },
        }),
      })
    );
    expect(saveRes.status).toBe(200);
    const savedBody = (await saveRes.json()) as OpenFinanceAdminConfigResponse;
    expect(savedBody.updated_by).toBe('steward@archive.example');
    expect(savedBody.persistence_available).toBe(true);
    expect(savedBody.summary.totals.annual_operating_cents).toBe(24000);
    expect(savedBody.summary.totals.monthly_operating_cents).toBe(2000);
    expect(savedBody.summary.funding_goal?.progress_percent).toBe(25);

    // Admin GET returns saved config
    const adminGetRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(adminGetRes.status).toBe(200);
    const adminGetBody = (await adminGetRes.json()) as OpenFinanceAdminConfigResponse;
    expect(adminGetBody.config.page_title).toBe('Updated Archive Costs');
    expect(adminGetBody.config.visibility.show_in_footer).toBe(false);

    // #44 declarative plugin-settings endpoint exposes schema, readonly summary, and validates updates
    const psListRes = await server.fetch(
      new Request('https://archive.example/api/admin/plugin-settings', {
        headers: { cookie: adminCookie },
      })
    );
    expect(psListRes.status).toBe(200);
    const psList = (await psListRes.json()) as {
      plugins: readonly {
        plugin_id: string;
        readonly_values: Record<string, unknown>;
        values: Record<string, unknown>;
      }[];
    };
    const ofSnapshot = psList.plugins.find((p) => p.plugin_id === OPEN_FINANCE_PLUGIN_ID);
    expect(ofSnapshot).toBeDefined();
    expect(ofSnapshot?.readonly_values['monthly_operating_cost']).toBe('$20.00');
    expect(ofSnapshot?.readonly_values['annual_operating_cost']).toBe('$240.00');
    expect(ofSnapshot?.readonly_values['active_platforms_count']).toBe(2);

    // Declarative PUT rejects non-allowlisted host via settingsSchema validator
    const badSettingsPut = await server.fetch(
      new Request(`https://archive.example/api/admin/plugin-settings/${OPEN_FINANCE_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            github_sponsors_url: 'https://evil.example/sponsors/alder',
          },
        }),
      })
    );
    expect(badSettingsPut.status).toBe(422);

    // Declarative PUT rejects primary platform without URL and invalid cost_ledger_json
    const badPrimarySettings = await server.fetch(
      new Request(`https://archive.example/api/admin/plugin-settings/${OPEN_FINANCE_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            primary_platform: 'paypal_me',
            cost_ledger_json: 'not-json',
          },
        }),
      })
    );
    expect(badPrimarySettings.status).toBe(422);

    // Declarative PUT rejects schema-invalid cost_ledger_json array and accepts cleared cost_ledger_json + auto primary_platform
    const badLedgerSchema = await server.fetch(
      new Request(`https://archive.example/api/admin/plugin-settings/${OPEN_FINANCE_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            cost_ledger_json: JSON.stringify([{ invalid: true }]),
          },
        }),
      })
    );
    expect(badLedgerSchema.status).toBe(422);

    const clearedLedgerPut = await server.fetch(
      new Request(`https://archive.example/api/admin/plugin-settings/${OPEN_FINANCE_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            primary_platform: 'auto',
            cost_ledger_json: '',
          },
        }),
      })
    );
    expect(clearedLedgerPut.status).toBe(200);

    // Declarative PUT with valid PayPal.me URL updates public summary
    const goodSettingsPut = await server.fetch(
      new Request(`https://archive.example/api/admin/plugin-settings/${OPEN_FINANCE_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            paypal_me_url: 'https://www.paypal.me/alderarchive',
            show_in_footer: true,
          },
        }),
      })
    );
    expect(goodSettingsPut.status).toBe(200);

    const refreshedPubRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}`)
    );
    const refreshedPub = (await refreshedPubRes.json()) as OpenFinancePublicSummary;
    expect(refreshedPub.visibility.show_in_footer).toBe(true);
    expect(refreshedPub.platforms.some((p) => p.url === 'https://paypal.me/alderarchive')).toBe(true);
  });

  it('works cleanly in memory when pluginSettingsStore is absent', async () => {
    const plugin = createOpenFinancePlugin();
    const basePorts = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = basePorts.clock;
    await basePorts.repository.upsertUser({
      email: 'steward@archive.example',
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'system:bootstrap',
      added_at: '2026-01-01T00:00:00.000Z',
      last_login_at: null,
    });
    const server = createKinloomServer({
      siteConfig,
      ports: { ...(({ pluginSettingsStore: _pss, ...rest }) => rest)(basePorts), plugins: [plugin] },
      sessionSecret: SESSION_SECRET,
      mode: 'public',
    });
    const adminCookie = await createSessionCookie({
      clock,
      email: 'steward@archive.example',
      role: 'admin',
      displayName: 'Archive Steward',
    });

    const putRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          page_title: 'In-Memory Ledger',
          platforms: [{ platform: 'ko_fi', handle: 'alderarchive' }],
        }),
      })
    );
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as OpenFinanceAdminConfigResponse;
    expect(body.persistence_available).toBe(false);
    expect(body.config.page_title).toBe('In-Memory Ledger');

    // Subpath checks on admin GET and PUT return 404
    const adminSubGet = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}/extra`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(adminSubGet.status).toBe(404);

    const adminSubPut = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}/extra`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      })
    );
    expect(adminSubPut.status).toBe(404);
  });

  it('enforces archive_read in private mode with private no-cache headers and preserves auxiliary keys across PluginSettingsSection saves', async () => {
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = ports.clock;
    await ports.repository.upsertUser({
      email: 'steward@archive.example',
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'system:bootstrap',
      added_at: '2026-01-01T00:00:00.000Z',
      last_login_at: null,
    });
    const rawBackupToken = 'kinloom_read_backup_probe_token_12345';
    const { sha256Hex } = await import('../crypto.js');
    await ports.repository.createAgentToken({
      token_id: 'tok_backup',
      label: 'Synthetic Probe',
      scope: 'read_backup',
      token_hash: await sha256Hex(rawBackupToken),
      created_by: 'steward@archive.example',
      created_at: '2026-01-01T00:00:00.000Z',
      revoked_at: null,
    });

    const plugin = createOpenFinancePlugin();
    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, plugins: [plugin] },
      sessionSecret: SESSION_SECRET,
      mode: 'private',
    });

    // Private archive: anonymous caller gets 401 (no ledger leak!)
    const anonRes = await server.fetch(new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}`));
    expect(anonRes.status).toBe(401);

    // Private archive: read_backup agent token succeeds with private, no-cache
    const agentRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}`, {
        headers: { authorization: `Bearer ${rawBackupToken}` },
      })
    );
    expect(agentRes.status).toBe(200);
    expect(agentRes.headers.get('cache-control')).toBe('private, no-cache');

    const adminCookie = await createSessionCookie({
      clock,
      email: 'steward@archive.example',
      role: 'admin',
      displayName: 'Archive Steward',
    });

    // Save Funding Goal + custom platform labels/order via OpenFinanceAdminPanel endpoint
    const saveAdminRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_ADMIN_ROUTE}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          page_title: 'Private Archive Support',
          nav_label: 'Support',
          currency: 'USD',
          visibility: { show_support_page: true, show_in_nav: false, show_in_footer: false },
          platforms: [
            {
              platform: 'ko_fi',
              handle: 'alderarchive',
              label: 'Buy Us Coffee on Ko-fi',
              description: 'Keeps backups online',
              enabled: true,
            },
            {
              platform: 'github_sponsors',
              handle: 'alder-archive',
              label: 'GitHub Sponsors Custom',
              enabled: true,
            },
          ],
          cost_items: [
            {
              id: 'cost-1',
              label: 'Domain',
              category: 'domain',
              cadence: 'annual',
              amount_cents: 1200,
              active: true,
            },
          ],
          funding_goal: {
            enabled: true,
            period: 'annual',
            target_cents: 12000,
            received_cents: 4500,
            label: '2026 Hosting Goal',
            as_of_date: '2026-11-27',
          },
        }),
      })
    );
    expect(saveAdminRes.status).toBe(200);

    // Now toggle show_in_nav & show_in_footer via declarative PluginSettingsSection endpoint
    const putSettingsRes = await server.fetch(
      new Request(`https://archive.example/api/admin/plugin-settings/${OPEN_FINANCE_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            show_in_nav: true,
            show_in_footer: true,
          },
        }),
      })
    );
    expect(putSettingsRes.status).toBe(200);
    const settingsPayload = (await putSettingsRes.json()) as {
      plugin: {
        schema: { sections: Array<{ id: string; fields: Array<{ key: string; helpText?: string }> }> };
      };
    };
    const visSection = settingsPayload.plugin.schema.sections.find((s) => s.id === 'visibility');
    expect(visSection?.fields.find((f) => f.key === 'show_in_nav')?.helpText).toContain(
      'Publish Open Finance & Support page'
    );
    expect(visSection?.fields.find((f) => f.key === 'show_in_footer')?.helpText).toContain(
      'Publish Open Finance & Support page'
    );

    // Verify platform_order_json (custom labels + order) AND funding_goal_json survived losslessly!
    const afterRes = await server.fetch(
      new Request(`https://archive.example${OPEN_FINANCE_PUBLIC_ROUTE}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(afterRes.status).toBe(200);
    expect(afterRes.headers.get('cache-control')).toBe('private, no-cache');
    const afterSummary = (await afterRes.json()) as OpenFinancePublicSummary;
    expect(afterSummary.visibility).toEqual({
      show_support_page: true,
      show_in_nav: true,
      show_in_footer: true,
    });
    expect(afterSummary.platforms.map((p) => ({ platform: p.platform, label: p.label }))).toEqual([
      { platform: 'ko_fi', label: 'Buy Us Coffee on Ko-fi' },
      { platform: 'github_sponsors', label: 'GitHub Sponsors Custom' },
    ]);
    expect(afterSummary.funding_goal).toMatchObject({
      period: 'annual',
      target_cents: 12000,
      received_cents: 4500,
      label: '2026 Hosting Goal',
      as_of_date: '2026-11-27',
    });
  });
});
