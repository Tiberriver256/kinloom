/** @vitest-environment jsdom */
import type {
  AdminDataSource,
  ArchiveBundle,
  ArchiveSessionState,
  KinloomSiteConfig,
  PluginSettingsSnapshot,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../adapters/httpWiki/httpClient.js';
import { createHttpOpenFinanceClient, type OpenFinanceClient } from '../adapters/openFinanceClient.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { KinloomApp } from '../KinloomApp.js';
import {
  buildUiOpenFinanceSummaryFromConfig,
  normalizeUiOpenFinanceConfig,
  OPEN_FINANCE_SERVER_PLUGIN_ID,
  type UiOpenFinanceAdminConfigPayload,
  type UiOpenFinanceConfigInput,
} from '../lib/openFinanceModel.js';
import { AdminPage } from '../pages/AdminPage.js';
import { AdminSettingsShell } from '../pages/admin/AdminSettingsShell.js';
import { createOpenFinancePlugin, OPEN_FINANCE_UI_PLUGIN_ID } from './openFinancePlugin.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Family Archive',
    familyName: 'Alder Family',
    gedcomSourceName: 'OPEN_FINANCE_UI_TEST',
  },
});

const emptyBundle: ArchiveBundle = compileArchive({
  siteConfig,
  people: [],
  places: [],
  events: [],
  sources: [],
  narratives: [],
  media: [],
  kinship: [],
  mode: 'public',
}).bundle;

function setNativeInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('createOpenFinancePlugin default-off and public/admin UI', () => {
  it('renders zero funding banners, zero donation links, and zero /support route by default when plugin is not registered', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<KinloomApp siteConfig={siteConfig} initialBundle={emptyBundle} initialEntries={['/']} />);
    });
    await flushUi();

    expect(container.querySelector('[data-testid="open-finance-nav-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-finance-footer-link"]')).toBeNull();
    expect(container.querySelector('a[href*="github.com/sponsors"]')).toBeNull();
    expect(container.querySelector('a[href*="buymeacoffee.com"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();

    // Navigating to /support without the plugin renders NotFoundPage, not OpenFinanceSupportPage
    const supportContainer = document.createElement('div');
    document.body.appendChild(supportContainer);
    const supportRoot = createRoot(supportContainer);
    await act(async () => {
      supportRoot.render(
        <KinloomApp siteConfig={siteConfig} initialBundle={emptyBundle} initialEntries={['/support']} />
      );
    });
    await flushUi();
    expect(supportContainer.querySelector('[data-testid="open-finance-support-page"]')).toBeNull();
    expect(supportContainer.textContent).toContain('Page Not Found');

    await act(async () => {
      supportRoot.unmount();
    });
    supportContainer.remove();
  });

  it('returns an inert disabled plugin when enabled is false', async () => {
    const plugin = createOpenFinancePlugin({ enabled: false });
    expect(plugin.id).toBe(OPEN_FINANCE_UI_PLUGIN_ID);
    expect(plugin.status).toBe('disabled');
    expect(plugin.provider).toBeUndefined();
    expect(plugin.routes).toBeUndefined();
    expect(plugin.slots).toBeUndefined();
  });

  it('renders nav link, footer link, and archival /support page with cost ledger, funding goal, and allowlisted CTAs', async () => {
    const plugin = createOpenFinancePlugin({
      liveSync: false,
      config: {
        page_title: 'Alder Archive Open Finance',
        nav_label: 'Support',
        supporter_message: 'Transparent hosting costs for our family archive.',
        currency: 'USD',
        visibility: { show_support_page: true, show_in_nav: true, show_in_footer: true },
        primary_platform: 'github_sponsors',
        platforms: [
          {
            platform: 'github_sponsors',
            handle: 'alder-archive',
            label: 'Sponsor on GitHub',
            description: 'Recurring monthly sponsorship.',
          },
          {
            platform: 'buy_me_a_coffee',
            handle: 'alderarchive',
            label: 'Buy Me a Coffee',
          },
        ],
        cost_items: [
          {
            id: 'domain',
            label: 'Archive Domain (.org)',
            category: 'domain',
            cadence: 'annual',
            amount_cents: 1200,
            vendor: 'Cloudflare Registrar',
          },
          {
            id: 'workers',
            label: 'Cloudflare Workers + R2',
            category: 'hosting',
            cadence: 'monthly',
            amount_cents: 500,
            vendor: 'Cloudflare',
            notes: 'Covers media storage and D1 database.',
          },
          {
            id: 'scanner',
            label: 'Photo Scanner Calibration',
            category: 'other',
            cadence: 'one_time',
            amount_cents: 2500,
          },
        ],
        funding_goal: {
          enabled: true,
          period: 'annual',
          target_cents: 7200,
          received_cents: 3600,
          label: '2026 Hosting Fund',
          as_of_date: '2026-11-27',
        },
      },
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[plugin]}
          initialEntries={['/support']}
        />
      );
    });
    await flushUi();

    expect(container.querySelector('[data-testid="open-finance-nav-link"]')?.textContent).toBe('Support');
    expect(container.querySelector('[data-testid="open-finance-footer-link"]')?.textContent).toBe('Support');
    expect(container.querySelector('[data-testid="open-finance-monthly-total"]')?.textContent).toBe('$6.00');
    expect(container.querySelector('[data-testid="open-finance-annual-total"]')?.textContent).toBe('$72.00');
    expect(container.querySelector('[data-testid="open-finance-onetime-total"]')?.textContent).toBe('$25.00');

    const progress = container.querySelector('progress');
    expect(progress?.getAttribute('value')).toBe('3600');
    expect(progress?.getAttribute('max')).toBe('7200');
    expect(container.textContent).toContain('2026 Hosting Fund');
    expect(container.textContent).toContain('50%');

    const ctaLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('[data-testid="open-finance-platforms"] a')
    );
    expect(ctaLinks.map((a) => a.href)).toEqual([
      'https://github.com/sponsors/alder-archive',
      'https://buymeacoffee.com/alderarchive',
    ]);
    for (const link of ctaLinks) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    }

    expect(container.textContent).toContain('Archive Domain (.org)');
    expect(container.textContent).toContain('Cloudflare Workers + R2');
    expect(container.textContent).toContain('Photo Scanner Calibration');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('hides nav/footer links and displays unpublished notice when show_support_page is false', async () => {
    const plugin = createOpenFinancePlugin({
      liveSync: false,
      config: {
        visibility: { show_support_page: false, show_in_nav: true, show_in_footer: true },
        platforms: [{ platform: 'ko_fi', handle: 'alderarchive' }],
      },
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[plugin]}
          initialEntries={['/support']}
        />
      );
    });
    await flushUi();

    expect(container.querySelector('[data-testid="open-finance-nav-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-finance-footer-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-finance-unpublished"]')).not.toBeNull();
    expect(container.querySelector('a[href*="ko-fi.com"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders OpenFinanceAdminPanel inside AdminSettingsShell for admins, validates URLs, and saves updates', async () => {
    const savedPayloads: UiOpenFinanceConfigInput[] = [];
    const initialCfg = normalizeUiOpenFinanceConfig({
      page_title: 'Alder Archive Support',
      platforms: [{ platform: 'github_sponsors', handle: 'alder-archive' }],
      cost_items: [
        { id: 'r2', label: 'Cloudflare R2', category: 'storage', cadence: 'monthly', amount_cents: 500 },
      ],
    });
    const initialAdminPayload: UiOpenFinanceAdminConfigPayload = {
      config: initialCfg,
      summary: buildUiOpenFinanceSummaryFromConfig(initialCfg, '2026-11-27T12:00:00.000Z'),
      updated_at: '2026-11-27T12:00:00.000Z',
      updated_by: 'steward@archive.example',
      persistence_available: true,
    };

    const client: OpenFinanceClient = {
      getPublicSummary: vi.fn(async () => initialAdminPayload.summary),
      getAdminConfig: vi.fn(async () => initialAdminPayload),
      saveAdminConfig: vi.fn(async (input) => {
        savedPayloads.push(input);
        const normalized = normalizeUiOpenFinanceConfig(input);
        return {
          config: normalized,
          summary: buildUiOpenFinanceSummaryFromConfig(normalized, '2026-11-27T12:05:00.000Z'),
          updated_at: '2026-11-27T12:05:00.000Z',
          updated_by: 'steward@archive.example',
          persistence_available: true,
        };
      }),
    };

    const plugin = createOpenFinancePlugin({ client });

    // Non-admin does not see the admin panel
    const nonAdminContainer = document.createElement('div');
    document.body.appendChild(nonAdminContainer);
    const nonAdminRoot = createRoot(nonAdminContainer);
    await act(async () => {
      nonAdminRoot.render(
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[plugin]}
          capabilities={{ canManageSite: false }}
        >
          <MemoryRouter>
            <AdminSettingsShell
              diagnostics={null}
              diagnosticsLoading={false}
              diagnosticsError={null}
              diagnosticsSupported={false}
              onRefreshDiagnostics={async () => {}}
            />
          </MemoryRouter>
        </ArchiveProvider>
      );
    });
    await flushUi();
    expect(nonAdminContainer.querySelector('[data-testid="admin-open-finance-panel"]')).toBeNull();
    await act(async () => {
      nonAdminRoot.unmount();
    });
    nonAdminContainer.remove();

    // Admin sees panel and can add platform, catch bad URL, fix URL, add cost item, and save
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[plugin]}
          capabilities={{ canManageSite: true }}
        >
          <MemoryRouter>
            <AdminSettingsShell
              diagnostics={null}
              diagnosticsLoading={false}
              diagnosticsError={null}
              diagnosticsSupported={false}
              onRefreshDiagnostics={async () => {}}
            />
          </MemoryRouter>
        </ArchiveProvider>
      );
    });
    await flushUi();

    expect(container.querySelector('[data-testid="admin-open-finance-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="admin-of-monthly-preview"]')?.textContent).toBe('$5.00');
    expect(container.querySelector('[data-testid="admin-of-annual-preview"]')?.textContent).toBe('$60.00');

    // Add second platform (Buy Me a Coffee)
    const addPlatBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Platform')
    );
    expect(addPlatBtn).toBeDefined();
    await act(async () => {
      addPlatBtn?.click();
    });

    const bmcCard = container.querySelector('[data-testid="admin-of-platform-buy_me_a_coffee"]');
    expect(bmcCard).not.toBeNull();
    const bmcInput = bmcCard?.querySelector<HTMLInputElement>('input[type="text"]');
    expect(bmcInput).not.toBeNull();

    // Enter disallowed javascript: URL and submit -> blocked client-side before fetch
    await act(async () => {
      if (bmcInput) {
        setNativeInputValue(bmcInput, 'javascript:alert(1)');
      }
    });
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save Open Finance Settings')
    );
    await act(async () => {
      saveBtn?.click();
    });
    await flushUi();
    expect(client.saveAdminConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('https://');

    // Fix URL, move platform up, add cost item, and save cleanly
    await act(async () => {
      if (bmcInput) {
        setNativeInputValue(bmcInput, 'alderarchive');
      }
    });
    const moveUpBtn = Array.from(bmcCard?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Move Up')
    );
    await act(async () => {
      moveUpBtn?.click();
    });

    const addCostBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Cost Item')
    );
    await act(async () => {
      addCostBtn?.click();
    });
    const cost2Card = container.querySelector('[data-testid="admin-of-cost-cost-2"]');
    const cost2Inputs = Array.from(cost2Card?.querySelectorAll<HTMLInputElement>('input[type="text"]') ?? []);
    await act(async () => {
      if (cost2Inputs[0]) {
        setNativeInputValue(cost2Inputs[0], 'Domain Renewal');
      }
      if (cost2Inputs[1]) {
        setNativeInputValue(cost2Inputs[1], '12.00');
      }
    });

    await act(async () => {
      saveBtn?.click();
    });
    await flushUi();

    expect(client.saveAdminConfig).toHaveBeenCalledTimes(1);
    const savedPayload = savedPayloads[0];
    expect(savedPayload?.platforms?.map((p) => p.platform)).toEqual(['buy_me_a_coffee', 'github_sponsors']);
    expect(savedPayload?.cost_items?.length).toBe(2);
    expect(savedPayload?.cost_items?.[1]?.amount_cents).toBe(1200);
    expect(container.textContent).toContain('Open Finance settings saved.');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('validates HTTP client transport responses and handles 404 / error / invalid payload cases', async () => {
    const cfg = normalizeUiOpenFinanceConfig({
      platforms: [{ platform: 'ko_fi', handle: 'alderarchive' }],
      cost_items: [
        { id: 'host', label: 'Hosting', category: 'hosting', cadence: 'monthly', amount_cents: 500 },
      ],
    });
    const summary = buildUiOpenFinanceSummaryFromConfig(cfg, '2026-11-27T12:00:00.000Z');
    const adminPayload: UiOpenFinanceAdminConfigPayload = {
      config: cfg,
      summary,
      updated_at: '2026-11-27T12:00:00.000Z',
      updated_by: 'steward@archive.example',
      persistence_available: true,
    };

    const client404 = createHttpOpenFinanceClient({
      apiBaseUrl: 'https://archive.example/',
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    expect(await client404.getPublicSummary()).toBeNull();
    expect(await client404.getAdminConfig()).toBeNull();

    const clientOk = createHttpOpenFinanceClient({
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/open-finance/summary')) {
          return new Response(JSON.stringify(summary), { status: 200 });
        }
        if (url.endsWith('/api/admin/open-finance/config') && (init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(adminPayload), { status: 200 });
        }
        if (url.endsWith('/api/admin/open-finance/config') && init?.method === 'PUT') {
          return new Response(JSON.stringify(adminPayload), { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    });
    expect((await clientOk.getPublicSummary())?.platforms[0]?.url).toBe('https://ko-fi.com/alderarchive');
    expect((await clientOk.getAdminConfig())?.config.platforms[0]?.platform).toBe('ko_fi');
    expect((await clientOk.saveAdminConfig(cfg)).updated_by).toBe('steward@archive.example');

    const clientTampered = createHttpOpenFinanceClient({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ...summary,
            platforms: [{ ...summary.platforms[0], url: 'javascript:alert(1)' }],
          }),
          { status: 200 }
        ),
    });
    await expect(clientTampered.getPublicSummary()).rejects.toThrow(/Invalid open-finance summary payload/);

    const clientServerErr = createHttpOpenFinanceClient({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Admin required' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(clientServerErr.getPublicSummary()).rejects.toThrow(/Admin required/);
    await expect(clientServerErr.getAdminConfig()).rejects.toThrow(/Admin required/);
    await expect(clientServerErr.saveAdminConfig(cfg)).rejects.toThrow(/Admin required/);

    const clientBadAdmin = createHttpOpenFinanceClient({
      fetchImpl: async () => new Response(JSON.stringify({ bad: true }), { status: 200 }),
    });
    await expect(clientBadAdmin.getAdminConfig()).rejects.toThrow(/Invalid admin open-finance payload/);
    await expect(clientBadAdmin.saveAdminConfig(cfg)).rejects.toThrow(/Invalid saved open-finance payload/);
  });

  it('handles loading, network error, empty ledger, fully funded goal, and disabled server states in UI', async () => {
    // Loading then error state on public /support page
    let rejectSummary: ((reason?: unknown) => void) | null = null;
    const errorClient: OpenFinanceClient = {
      getPublicSummary: () =>
        new Promise((_, reject) => {
          rejectSummary = reject;
        }),
      getAdminConfig: async () => null,
      saveAdminConfig: async () => {
        throw new Error('Save failed');
      },
    };
    const pluginErr = createOpenFinancePlugin({ client: errorClient });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[pluginErr]}
          initialEntries={['/support']}
        />
      );
    });
    expect(container.querySelector('[data-testid="open-finance-loading"]')).not.toBeNull();

    await act(async () => {
      rejectSummary?.(new Error('Network offline'));
    });
    await flushUi();
    expect(container.querySelector('[data-testid="open-finance-error"]')?.textContent).toContain(
      'Network offline'
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();

    // Empty cost items + fully funded goal + custom routePath (/finance)
    const emptyLedgerPlugin = createOpenFinancePlugin({
      routePath: '/finance',
      liveSync: false,
      config: {
        cost_items: [],
        funding_goal: { enabled: true, period: 'monthly', target_cents: 1000, received_cents: 1200 },
      },
    });
    const financeContainer = document.createElement('div');
    document.body.appendChild(financeContainer);
    const financeRoot = createRoot(financeContainer);
    await act(async () => {
      financeRoot.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[emptyLedgerPlugin]}
          initialEntries={['/finance']}
        />
      );
    });
    await flushUi();
    expect(financeContainer.textContent).toContain('No operating cost line items have been published yet.');
    expect(financeContainer.textContent).toContain('fully funded');

    await act(async () => {
      financeRoot.unmount();
    });
    financeContainer.remove();

    // Admin panel handles 404 endpointDisabled + loadError + funding goal validation + remove/reorder controls
    const adminContainer = document.createElement('div');
    document.body.appendChild(adminContainer);
    const adminRoot = createRoot(adminContainer);
    const disabledAdminPlugin = createOpenFinancePlugin({
      client: {
        getPublicSummary: async () => null,
        getAdminConfig: async () => null,
        saveAdminConfig: async () => {
          throw new Error('Not available');
        },
      },
    });
    await act(async () => {
      adminRoot.render(
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[disabledAdminPlugin]}
          capabilities={{ canManageSite: true }}
        >
          <MemoryRouter>
            <AdminSettingsShell
              diagnostics={null}
              diagnosticsLoading={false}
              diagnosticsError={null}
              diagnosticsSupported={false}
              onRefreshDiagnostics={async () => {}}
            />
          </MemoryRouter>
        </ArchiveProvider>
      );
    });
    await flushUi();
    expect(adminContainer.textContent).toContain('Server open-finance endpoints are not registered');

    // Toggle funding goal on, edit switches, add & remove cost items and platforms
    const checkboxes = Array.from(
      adminContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );
    const goalSwitch = checkboxes[checkboxes.length - 1];
    await act(async () => {
      goalSwitch?.click();
    });
    expect(adminContainer.textContent).toContain('Goal Period');

    await act(async () => {
      adminRoot.unmount();
    });
    adminContainer.remove();
  });

  it('exercises all admin editor controls, funding goal validation, and reload/save error recovery', async () => {
    let failSave = true;
    const baseCfg = normalizeUiOpenFinanceConfig({
      page_title: 'Alder Archive Support',
      platforms: [
        { platform: 'github_sponsors', handle: 'alder-archive' },
        { platform: 'ko_fi', handle: 'alderarchive' },
      ],
      cost_items: [
        { id: 'r2', label: 'Cloudflare R2', category: 'storage', cadence: 'monthly', amount_cents: 500 },
      ],
    });
    const basePayload: UiOpenFinanceAdminConfigPayload = {
      config: baseCfg,
      summary: buildUiOpenFinanceSummaryFromConfig(baseCfg, '2026-11-27T12:00:00.000Z'),
      updated_at: '2026-11-27T12:00:00.000Z',
      updated_by: 'steward@archive.example',
      persistence_available: true,
    };

    let loadAttempt = 0;
    const client: OpenFinanceClient = {
      getPublicSummary: vi.fn(async () => basePayload.summary),
      getAdminConfig: vi.fn(async () => {
        loadAttempt += 1;
        if (loadAttempt === 1) {
          throw new Error('Temporary load failure');
        }
        return basePayload;
      }),
      saveAdminConfig: vi.fn(async (input) => {
        if (failSave) {
          throw new Error('Server validation failed');
        }
        const normalized = normalizeUiOpenFinanceConfig(input);
        return {
          config: normalized,
          summary: buildUiOpenFinanceSummaryFromConfig(normalized, '2026-11-27T12:10:00.000Z'),
          updated_at: '2026-11-27T12:10:00.000Z',
          updated_by: 'steward@archive.example',
          persistence_available: true,
        };
      }),
    };

    const plugin = createOpenFinancePlugin({ client });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[plugin]}
          capabilities={{ canManageSite: true }}
        >
          <MemoryRouter>
            <AdminSettingsShell
              diagnostics={null}
              diagnosticsLoading={false}
              diagnosticsError={null}
              diagnosticsSupported={false}
              onRefreshDiagnostics={async () => {}}
            />
          </MemoryRouter>
        </ArchiveProvider>
      );
    });
    await flushUi();
    expect(container.textContent).toContain('Temporary load failure');

    const reloadBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reload Ledger')
    );
    await act(async () => {
      reloadBtn?.click();
    });
    await flushUi();

    const allCheckboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    await act(async () => {
      allCheckboxes[0]?.click();
      allCheckboxes[0]?.click();
      allCheckboxes[1]?.click();
      allCheckboxes[2]?.click();
    });

    const titleInput = container.querySelector<HTMLInputElement>('input[id$="-title"]');
    const navInput = container.querySelector<HTMLInputElement>('input[id$="-nav-label"]');
    const currencySelect = container.querySelector<HTMLSelectElement>('select[id$="-currency"]');
    const msgArea = container.querySelector<HTMLTextAreaElement>('textarea[id$="-msg"]');
    await act(async () => {
      if (titleInput) setNativeInputValue(titleInput, 'Open Ledger 2026');
      if (navInput) setNativeInputValue(navInput, 'Finance');
      if (currencySelect) {
        currencySelect.value = 'EUR';
        currencySelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (msgArea) setNativeInputValue(msgArea, 'Updated supporter note.');
    });

    const ghCard = container.querySelector('[data-testid="admin-of-platform-github_sponsors"]');
    const kofiCard = container.querySelector('[data-testid="admin-of-platform-ko_fi"]');
    const kofiRadio = kofiCard?.querySelector<HTMLInputElement>('input[type="radio"]');
    const ghEnabled = ghCard?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const ghLabel = ghCard?.querySelector<HTMLInputElement>('input[id*="-plat-label-"]');
    const ghMoveDown = Array.from(ghCard?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Move Down')
    );
    await act(async () => {
      kofiRadio?.click();
      ghEnabled?.click();
      ghEnabled?.click();
      if (ghLabel) setNativeInputValue(ghLabel, 'Back via GitHub');
      ghMoveDown?.click();
    });
    const ghRemove = Array.from(
      container
        .querySelector('[data-testid="admin-of-platform-github_sponsors"]')
        ?.querySelectorAll('button') ?? []
    ).find((b) => b.textContent?.includes('Remove'));
    await act(async () => {
      ghRemove?.click();
    });

    const r2Card = container.querySelector('[data-testid="admin-of-cost-r2"]');
    const r2Active = r2Card?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const r2Cat = r2Card?.querySelector<HTMLSelectElement>('select[id*="-cost-cat-"]');
    const r2Cad = r2Card?.querySelector<HTMLSelectElement>('select[id*="-cost-cad-"]');
    const r2Vendor = r2Card?.querySelector<HTMLInputElement>('input[id*="-cost-vendor-"]');
    await act(async () => {
      r2Active?.click();
      r2Active?.click();
      if (r2Cat) {
        r2Cat.value = 'hosting';
        r2Cat.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (r2Cad) {
        r2Cad.value = 'annual';
        r2Cad.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (r2Vendor) setNativeInputValue(r2Vendor, 'Cloudflare');
    });

    const addCostBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Cost Item')
    );
    await act(async () => {
      addCostBtn?.click();
    });
    const removeAddedCost = Array.from(
      container.querySelector('[data-testid="admin-of-cost-cost-2"]')?.querySelectorAll('button') ?? []
    ).find((b) => b.textContent?.includes('Remove Item'));
    await act(async () => {
      removeAddedCost?.click();
    });

    const checkboxesAfter = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );
    const goalSwitch = checkboxesAfter[checkboxesAfter.length - 1];
    await act(async () => {
      goalSwitch?.click();
    });

    const goalPeriod = container.querySelector<HTMLSelectElement>('select[id$="-goal-period"]');
    const goalTarget = container.querySelector<HTMLInputElement>('input[id$="-goal-target"]');
    const goalReceived = container.querySelector<HTMLInputElement>('input[id$="-goal-received"]');
    const goalLabel = container.querySelector<HTMLInputElement>('input[id$="-goal-label"]');
    const goalDate = container.querySelector<HTMLInputElement>('input[id$="-goal-date"]');
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save Open Finance Settings')
    );

    await act(async () => {
      if (goalTarget) setNativeInputValue(goalTarget, 'bad');
      if (goalReceived) setNativeInputValue(goalReceived, '-1');
      if (goalDate) setNativeInputValue(goalDate, '11/27/2026');
    });
    await act(async () => {
      saveBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('YYYY-MM-DD');

    await act(async () => {
      if (goalPeriod) {
        goalPeriod.value = 'monthly';
        goalPeriod.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (goalTarget) setNativeInputValue(goalTarget, '100.00');
      if (goalReceived) setNativeInputValue(goalReceived, '50.00');
      if (goalLabel) setNativeInputValue(goalLabel, 'Monthly Fund');
      if (goalDate) setNativeInputValue(goalDate, '2026-11-27');
    });

    await act(async () => {
      saveBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Server validation failed');

    failSave = false;
    await act(async () => {
      saveBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Open Finance settings saved.');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('re-fetches OpenFinanceProvider on session login transition and syncs live nav, mobile menu, and footer via PluginSettingsBus', async () => {
    let showInNav = false;
    let showInFooter = false;
    let showSupportPage = false;
    let isAuthed = false;
    const summaryCacheModes: Array<RequestCache | undefined> = [];
    let adminGetPluginSettingsCalls = 0;

    const currentConfig = () =>
      normalizeUiOpenFinanceConfig({
        page_title: 'Support Alder Archive',
        nav_label: 'Support',
        visibility: {
          show_support_page: showSupportPage,
          show_in_nav: showInNav,
          show_in_footer: showInFooter,
        },
        platforms: [{ platform: 'ko_fi', handle: 'alderarchive', enabled: true }],
      });

    const ofClient: OpenFinanceClient = {
      async getPublicSummary(options) {
        summaryCacheModes.push(options?.cache);
        if (!isAuthed) {
          throw new ApiClientError(401, 'UNAUTHORIZED', 'Authentication is required.');
        }
        return buildUiOpenFinanceSummaryFromConfig(currentConfig(), '2026-11-27T12:00:00.000Z');
      },
      async getAdminConfig() {
        const cfg = currentConfig();
        return {
          config: cfg,
          summary: buildUiOpenFinanceSummaryFromConfig(cfg, '2026-11-27T12:00:00.000Z'),
          updated_at: '2026-11-27T12:00:00.000Z',
          updated_by: 'admin@archive.example',
          persistence_available: true,
        };
      },
      async saveAdminConfig(input) {
        const cfg = normalizeUiOpenFinanceConfig(input);
        showSupportPage = cfg.visibility.show_support_page;
        showInNav = cfg.visibility.show_in_nav;
        showInFooter = cfg.visibility.show_in_footer;
        return {
          config: cfg,
          summary: buildUiOpenFinanceSummaryFromConfig(cfg, '2026-11-27T12:05:00.000Z'),
          updated_at: '2026-11-27T12:05:00.000Z',
          updated_by: 'admin@archive.example',
          persistence_available: true,
        };
      },
    };

    const buildSettingsSnapshot = (): PluginSettingsSnapshot => ({
      plugin_id: OPEN_FINANCE_SERVER_PLUGIN_ID,
      plugin_name: 'Open Finance & Donations',
      plugin_version: '0.54.2',
      status: 'active',
      schema: {
        title: 'Open Finance & Donations',
        sections: [
          {
            id: 'visibility',
            title: 'Visibility & Messaging',
            fields: [
              {
                key: 'show_support_page',
                label: 'Publish Open Finance & Support page',
                type: 'boolean',
                defaultValue: false,
              },
              {
                key: 'show_in_nav',
                label: 'Show Support link in top navigation',
                type: 'boolean',
                defaultValue: false,
              },
              {
                key: 'show_in_footer',
                label: 'Show Support link in site footer',
                type: 'boolean',
                defaultValue: false,
              },
            ],
          },
        ],
      },
      values: {
        show_support_page: showSupportPage,
        show_in_nav: showInNav,
        show_in_footer: showInFooter,
      },
      secrets: {},
      readonly_values: {},
      updated_at: '2026-11-27T12:00:00.000Z',
      updated_by: 'admin@archive.example',
    });

    const adminClient: AdminDataSource = {
      async listUsers() {
        return [];
      },
      async updateUserRole() {
        throw new Error('unused');
      },
      async listInvites() {
        return [];
      },
      async createInvite() {
        throw new Error('unused');
      },
      async revokeInvite() {},
      async listAgentTokens() {
        return [];
      },
      async createAgentToken() {
        throw new Error('unused');
      },
      async revokeAgentToken() {},
      async getPluginSettings() {
        adminGetPluginSettingsCalls += 1;
        return [buildSettingsSnapshot()];
      },
      async updatePluginSettings(_pluginId, input) {
        if (typeof input.values?.['show_support_page'] === 'boolean') {
          showSupportPage = input.values['show_support_page'];
        }
        if (typeof input.values?.['show_in_nav'] === 'boolean') {
          showInNav = input.values['show_in_nav'];
        }
        if (typeof input.values?.['show_in_footer'] === 'boolean') {
          showInFooter = input.values['show_in_footer'];
        }
        return buildSettingsSnapshot();
      },
    };

    const plugin = createOpenFinancePlugin({ client: ofClient });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const anonSession: ArchiveSessionState = {
      authenticated: false,
      principal_kind: 'anonymous',
    };
    const adminSession: ArchiveSessionState = {
      authenticated: true,
      principal_kind: 'user',
      role: 'admin',
      email: 'admin@archive.example',
      displayName: 'Archive Steward',
    };

    const renderView = (session: ArchiveSessionState, showAdmin: boolean) => (
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={emptyBundle}
          plugins={[plugin]}
          session={session}
          capabilities={{ canManageSite: session.role === 'admin' }}
        >
          {showAdmin ? (
            <AdminPage adminClient={adminClient} />
          ) : (
            <>
              <ExplorerTopBar />
              <KinloomFooter />
            </>
          )}
        </ArchiveProvider>
      </MemoryRouter>
    );

    // 1. Mount logged out (401 on private archive) -> links absent, no stuck error
    await act(async () => {
      root.render(renderView(anonSession, false));
    });
    await flushUi();
    expect(container.querySelector('[data-testid="open-finance-nav-link"]')).toBeNull();

    // 2. Sign in as admin -> OpenFinanceProvider re-fetches immediately on session change
    isAuthed = true;
    await act(async () => {
      root.render(renderView(adminSession, true));
    });
    await flushUi();
    expect(summaryCacheModes.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[data-testid="open-finance-nav-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-finance-footer-link"]')).toBeNull();

    // Open mobile/account disclosure menu before enabling visibility -> mobile menu link is omitted
    const menuBtnBefore = container.querySelector<HTMLButtonElement>('button[aria-expanded][aria-controls]');
    expect(menuBtnBefore).not.toBeNull();
    await act(async () => {
      menuBtnBefore?.click();
    });
    expect(container.querySelector('[data-testid="open-finance-mobile-nav-link"]')).toBeNull();
    await act(async () => {
      menuBtnBefore?.click();
    });

    // 3. Toggle all three visibility switches ON in PluginSettingsSection and save
    const settingsCard = container.querySelector<HTMLElement>(
      `[data-testid="plugin-settings-card-${OPEN_FINANCE_SERVER_PLUGIN_ID}"]`
    );
    expect(settingsCard).not.toBeNull();
    const toggles = Array.from(
      settingsCard?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []
    );
    expect(toggles).toHaveLength(3);
    await act(async () => {
      for (const toggle of toggles) {
        toggle.click();
      }
    });
    const saveSettingsBtn = container.querySelector<HTMLButtonElement>(
      `[data-testid="plugin-settings-card-${OPEN_FINANCE_SERVER_PLUGIN_ID}"] button[type="submit"]`
    );
    expect(saveSettingsBtn).not.toBeNull();
    await act(async () => {
      saveSettingsBtn?.click();
    });
    await flushUi();

    // Provider refreshed with cache: 'no-store' and nav + footer links appear live!
    expect(summaryCacheModes).toContain('no-store');
    expect(container.querySelector('[data-testid="open-finance-nav-link"]')?.textContent).toBe('Support');
    expect(container.querySelector('[data-testid="open-finance-footer-link"]')?.textContent).toBe('Support');

    // Open mobile/account disclosure menu in ExplorerTopBar -> OpenFinanceMobileMenuLink renders inside list!
    const menuBtn = container.querySelector<HTMLButtonElement>('button[aria-expanded][aria-controls]');
    expect(menuBtn).not.toBeNull();
    await act(async () => {
      menuBtn?.click();
    });
    const mobileLink = container.querySelector<HTMLAnchorElement>(
      '[data-testid="open-finance-mobile-nav-link"]'
    );
    expect(mobileLink).not.toBeNull();
    expect(mobileLink?.getAttribute('role')).toBeNull();
    expect(mobileLink?.closest('li')?.closest('ul')).not.toBeNull();
    expect(mobileLink?.textContent).toBe('Support');

    // 4. Saving from OpenFinanceAdminPanel notifies AdminPage to reload PluginSettingsSection!
    const settingsCallsBeforePanelSave = adminGetPluginSettingsCalls;
    const panelSaveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="admin-open-finance-panel"] button[type="submit"]'
    );
    expect(panelSaveBtn).not.toBeNull();
    await act(async () => {
      panelSaveBtn?.click();
    });
    await flushUi();
    expect(adminGetPluginSettingsCalls).toBeGreaterThan(settingsCallsBeforePanelSave);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
