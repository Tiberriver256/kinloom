/** @vitest-environment jsdom */
import type {
  AdminDataSource,
  ArchiveBundle,
  ArchiveSessionState,
  KinloomSiteConfig,
  Narrative,
  Person,
  Place,
  PluginSettingsSnapshot,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  createHttpObservabilityStatsClient,
  type ObservabilityStatsClient,
} from '../adapters/observabilityStatsClient.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import {
  OBSERVABILITY_STATS_SERVER_PLUGIN_ID,
  type UiAdminObservabilityStats,
  type UiObservabilityStatsWindow,
} from '../lib/observabilityStatsModel.js';
import { AdminPage } from '../pages/AdminPage.js';
import { AdminSettingsShell } from '../pages/admin/AdminSettingsShell.js';
import {
  createObservabilityStatsPlugin,
  OBSERVABILITY_STATS_UI_PLUGIN_ID,
} from './observabilityStatsPlugin.js';
import { KinloomPluginProvider, PluginSlot, useKinloomPlugins } from './PluginContext.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SnapshotlessBusTrigger: React.FC = () => {
  const { notifyPluginSettingsUpdated } = useKinloomPlugins();
  return (
    <button
      type="button"
      data-testid="trigger-snapshotless-bus"
      onClick={() => {
        notifyPluginSettingsUpdated({
          pluginId: 'kinloom-page-visit-stats',
          source: 'plugin-settings-section',
        });
      }}
    >
      Notify
    </button>
  );
};

const ReloadArchiveTrigger: React.FC = () => {
  const { reloadArchive } = useArchiveData();
  return (
    <button type="button" data-testid="reload-archive-btn" onClick={reloadArchive}>
      Reload
    </button>
  );
};

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Observability Archive',
    familyName: 'Alder Family',
    gedcomSourceName: 'OBS_UI_TEST',
  },
});

const deceasedPerson: Person = {
  id: 'per_arthur',
  slug: 'arthur-alder',
  full_name: 'Arthur Alder',
  given_name: 'Arthur',
  surname: 'Alder',
  alt_names: [],
  sex: 'M',
  is_living: false,
  lineage_group: 'direct',
  birth_edtf: '1850',
  death_edtf: '1920',
  portrait_url: null,
  birth_year: 1850,
  death_year: 1920,
  event_count: 0,
  primary_place_id: null,
};

const livingPerson: Person = {
  id: 'per_clara_living',
  slug: 'clara-living-alder',
  full_name: 'Clara Living Alder',
  given_name: 'Clara',
  surname: 'Alder',
  alt_names: [],
  sex: 'F',
  is_living: true,
  lineage_group: 'extended',
  birth_edtf: '1998',
  death_edtf: '',
  portrait_url: null,
  birth_year: 1998,
  death_year: null,
  event_count: 0,
  primary_place_id: null,
};

const place: Place = {
  id: 'plc_oakridge',
  slug: 'oakridge-ohio',
  name: 'Oakridge',
  full_name: 'Oakridge, Ohio, USA',
  place_type: 'town',
  lat: 40.1,
  lng: -82.9,
  parent_id: null,
};

const publicNarrative: Narrative = {
  id: 'nar_mill',
  slug: 'oakridge-mill',
  title: 'The Oakridge Mill',
  kind: 'family_story',
  body_md: 'Historical mill story.',
  person_ids: ['per_arthur'],
  place_ids: ['plc_oakridge'],
  event_ids: [],
  source_ids: [],
};

const livingNarrative: Narrative = {
  id: 'nar_living',
  slug: 'clara-notes',
  title: 'Living Notes',
  kind: 'family_story',
  body_md: 'Living relative note.',
  person_ids: ['per_clara_living'],
  place_ids: [],
  event_ids: [],
  source_ids: [],
};

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig,
  mode: 'private',
  people: [deceasedPerson, livingPerson],
  places: [place],
  events: [],
  sources: [],
  kinship: [],
  narratives: [publicNarrative, livingNarrative],
});

function createStatsFixture(overrides: Partial<UiAdminObservabilityStats> = {}): UiAdminObservabilityStats {
  return {
    generated_at: '2026-11-27T12:00:00.000Z',
    window: '30d',
    privacy_mode: 'aggregate-cookie-free',
    public_badges_enabled: false,
    bundle_revision: 7,
    workers_observability_paired: true,
    totals: { views_7d: 18, views_30d: 64, views_all_time: 140 },
    cache: { hits: 9, misses: 1, not_modified: 0, total_requests: 10, hit_ratio: 0.9 },
    daily_trend: [
      { day_utc: '2026-11-25', views: 4 },
      { day_utc: '2026-11-26', views: 6 },
      { day_utc: '2026-11-27', views: 8 },
    ],
    top_pages: [
      { route_key: '/', entity_kind: 'route', entity_slug: null, title: 'Archive Home', views: 30 },
      {
        route_key: '/person/arthur-alder',
        entity_kind: 'person',
        entity_slug: 'arthur-alder',
        title: 'Arthur Alder',
        views: 22,
      },
    ],
    top_by_kind: {
      people: [
        {
          route_key: '/person/arthur-alder',
          entity_kind: 'person',
          entity_slug: 'arthur-alder',
          title: 'Arthur Alder',
          views: 22,
        },
      ],
      places: [
        {
          route_key: '/place/oakridge-ohio',
          entity_kind: 'place',
          entity_slug: 'oakridge-ohio',
          title: 'Oakridge, Ohio, USA',
          views: 9,
        },
      ],
      narratives: [
        {
          route_key: '/narrative/oakridge-mill',
          entity_kind: 'narrative',
          entity_slug: 'oakridge-mill',
          title: 'The Oakridge Mill',
          views: 5,
        },
      ],
    },
    ...overrides,
  };
}

describe('ObservabilityStats UI plugin (AdminSettingsShell dashboard & per-page badges)', () => {
  it('renders zero observability chrome when unconfigured or created with { enabled: false }', async () => {
    const disabledPlugin = createObservabilityStatsPlugin({ enabled: false });
    expect(disabledPlugin.id).toBe(OBSERVABILITY_STATS_UI_PLUGIN_ID);
    expect(disabledPlugin.status).toBe('disabled');
    expect(disabledPlugin.slots).toBeUndefined();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ArchiveProvider
            siteConfig={siteConfig}
            initialBundle={testBundle}
            capabilities={{ canEdit: true, canManageSite: true, canUploadMedia: true }}
          >
            <KinloomPluginProvider plugins={[disabledPlugin]}>
              <AdminSettingsShell
                diagnostics={null}
                diagnosticsLoading={false}
                diagnosticsError={null}
                diagnosticsSupported={false}
                onRefreshDiagnostics={async () => {}}
              />
              <PluginSlot name="personDetail" person={deceasedPerson} />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="admin-observability-stats"]')).toBeNull();
    expect(container.querySelector('[data-testid="page-visit-badge-person"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders Admin Settings observability dashboard with chart, window/category filters, and live badge toggle', async () => {
    const requestedWindows: UiObservabilityStatsWindow[] = [];
    const badgeToggleCalls: boolean[] = [];
    let currentBadges = false;

    const fakeClient: ObservabilityStatsClient = {
      async getAdminStats(win = '30d') {
        requestedWindows.push(win);
        return createStatsFixture({ window: win, public_badges_enabled: currentBadges });
      },
      async setPublicBadgesEnabled(next) {
        badgeToggleCalls.push(next);
        currentBadges = next;
        return next;
      },
      async getPublicPageVisitCount(params) {
        return {
          route_key: `/${params.kind}/${params.slug}`,
          entity_kind: params.kind,
          entity_slug: params.slug,
          total_views: 22,
        };
      },
    };

    const plugin = createObservabilityStatsPlugin({ client: fakeClient });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ArchiveProvider
            siteConfig={siteConfig}
            initialBundle={testBundle}
            capabilities={{ canEdit: true, canManageSite: true, canUploadMedia: true }}
          >
            <KinloomPluginProvider plugins={[plugin]}>
              <AdminSettingsShell
                diagnostics={null}
                diagnosticsLoading={false}
                diagnosticsError={null}
                diagnosticsSupported={false}
                onRefreshDiagnostics={async () => {}}
              />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 25));
    });

    expect(container.querySelector('[data-testid="admin-observability-stats"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="obs-views-7d"]')?.textContent).toBe('18');
    expect(container.querySelector('[data-testid="obs-views-30d"]')?.textContent).toBe('64');
    expect(container.querySelector('[data-testid="obs-views-all"]')?.textContent).toBe('140');
    expect(container.querySelector('[data-testid="obs-bundle-rev"]')?.textContent).toBe('r7');
    expect(container.querySelector('[data-testid="obs-cache-ratio"]')?.textContent).toBe('90% (9/10)');
    expect(container.querySelector('[data-testid="obs-daily-trend-chart"]')).not.toBeNull();
    expect(container.textContent).toContain('Arthur Alder');

    // Switch window to 7 Days:
    const sevenDayBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '7 Days');
    await act(async () => {
      sevenDayBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(requestedWindows).toContain('7d');

    // Switch category filter to Places and Narratives:
    const placesBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Places');
    await act(async () => {
      placesBtn?.click();
    });
    expect(container.textContent).toContain('Oakridge, Ohio, USA');

    const narrativesBtn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Narratives'
    );
    await act(async () => {
      narrativesBtn?.click();
    });
    expect(container.textContent).toContain('The Oakridge Mill');

    // Toggle public badges switch ON:
    const toggle = container.querySelector<HTMLInputElement>('[data-testid="obs-public-badges-switch"]');
    expect(toggle?.checked).toBe(false);
    await act(async () => {
      toggle?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(badgeToggleCalls).toEqual([true]);
    expect(container.textContent).toContain('Public visit counts enabled.');

    // Refresh button reloads stats:
    const refreshBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Refresh Stats')
    );
    await act(async () => {
      refreshBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(requestedWindows.length).toBeGreaterThanOrEqual(3);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('handles disabled server (404), fetch error, and toggle save failure gracefully', async () => {
    const disabledClient: ObservabilityStatsClient = {
      async getAdminStats() {
        return null;
      },
      async setPublicBadgesEnabled() {
        throw new Error('save failed');
      },
      async getPublicPageVisitCount() {
        return null;
      },
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ArchiveProvider
            siteConfig={siteConfig}
            initialBundle={testBundle}
            capabilities={{ canEdit: true, canManageSite: true, canUploadMedia: true }}
          >
            <KinloomPluginProvider plugins={[createObservabilityStatsPlugin({ client: disabledClient })]}>
              <PluginSlot name="adminSettings" />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="obs-stats-disabled-note"]')).not.toBeNull();

    const failingClient: ObservabilityStatsClient = {
      async getAdminStats() {
        throw new Error('Server stats error');
      },
      async setPublicBadgesEnabled() {
        throw new Error('Toggle denied');
      },
      async getPublicPageVisitCount() {
        return null;
      },
    };

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ArchiveProvider
            siteConfig={siteConfig}
            initialBundle={testBundle}
            capabilities={{ canEdit: true, canManageSite: true, canUploadMedia: true }}
          >
            <KinloomPluginProvider plugins={[createObservabilityStatsPlugin({ client: failingClient })]}>
              <PluginSlot name="adminSettings" />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent).toContain('Server stats error');

    // Non-admin receives null from adminSettings slot:
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ArchiveProvider
            siteConfig={siteConfig}
            initialBundle={testBundle}
            capabilities={{ canEdit: false, canManageSite: false, canUploadMedia: false }}
          >
            <KinloomPluginProvider plugins={[createObservabilityStatsPlugin({ client: disabledClient })]}>
              <PluginSlot name="adminSettings" />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(container.querySelector('[data-testid="admin-observability-stats"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders subtle archival badges for deceased person, place, and public narrative while strictly excluding living people', async () => {
    const queriedSlugs: string[] = [];
    const badgeClient: ObservabilityStatsClient = {
      async getAdminStats() {
        return createStatsFixture({ public_badges_enabled: true });
      },
      async setPublicBadgesEnabled(next) {
        return next;
      },
      async getPublicPageVisitCount(params) {
        queriedSlugs.push(`${params.kind}:${params.slug}`);
        if (params.kind === 'person') {
          return {
            route_key: '/person/arthur-alder',
            entity_kind: 'person',
            entity_slug: params.slug,
            total_views: 19,
          };
        }
        if (params.kind === 'place') {
          return {
            route_key: '/place/oakridge-ohio',
            entity_kind: 'place',
            entity_slug: params.slug,
            total_views: 1,
          };
        }
        return {
          route_key: '/narrative/oakridge-mill',
          entity_kind: 'narrative',
          entity_slug: params.slug,
          total_views: 7,
        };
      },
    };

    const plugin = createObservabilityStatsPlugin({
      client: badgeClient,
      showPublicVisitBadges: true,
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle}>
            <KinloomPluginProvider plugins={[plugin]}>
              <PluginSlot name="personDetail" person={deceasedPerson} />
              <PluginSlot name="personDetail" person={livingPerson} />
              <PluginSlot name="placeDetail" place={place} />
              <PluginSlot name="narrativeHeader" person={deceasedPerson} narrative={publicNarrative} />
              <PluginSlot name="narrativeHeader" person={livingPerson} narrative={livingNarrative} />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(container.querySelector('[data-testid="page-visit-badge-person"]')?.textContent).toBe('19 visits');
    expect(container.querySelector('[data-testid="page-visit-badge-place"]')?.textContent).toBe('1 visit');
    // P1-6: narrativeHeader omits permanently-zero narrative badges until standalone narrative routes exist
    expect(container.querySelector('[data-testid="page-visit-badge-narrative"]')).toBeNull();

    // Living person and living-linked narrative never trigger any network call or badge render!
    expect(queriedSlugs).toEqual(['person:arthur-alder', 'place:oakridge-ohio']);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('hydrates showPublicBadges from /api/observability/config on mount and login transition, and sends SPA visit beacons', async () => {
    const beacons: string[] = [];
    let configCalls = 0;
    const client: ObservabilityStatsClient = {
      async getAdminStats() {
        return null;
      },
      async setPublicBadgesEnabled(enabled) {
        return enabled;
      },
      async getPublicConfig() {
        configCalls += 1;
        return { enabled: true, public_badges_enabled: true, record_spa_beacons: true };
      },
      async getPublicPageVisitCount(params) {
        return {
          route_key: `/${params.kind}/${params.slug}`,
          entity_kind: params.kind,
          entity_slug: params.slug,
          total_views: 11,
        };
      },
      async recordPageVisit(path) {
        beacons.push(path);
      },
    };

    const plugin = createObservabilityStatsPlugin({ client, showPublicVisitBadges: false });
    const deceasedPerson = testBundle.people.find((p) => p.slug === 'arthur-alder') as Person;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    const anonSession: ArchiveSessionState = {
      authenticated: false,
      principal_kind: 'anonymous',
    };
    const memberSession: ArchiveSessionState = {
      authenticated: true,
      principal_kind: 'user',
      role: 'editor',
      email: 'editor@archive.example',
      displayName: 'Family Editor',
    };

    let isAuthed = false;
    const loader = {
      async loadArchive() {
        if (!isAuthed) {
          throw new Error('Authentication required');
        }
        return testBundle;
      },
      async loadReadings() {
        return null;
      },
    };

    const renderWithState = (session: ArchiveSessionState) => (
      <MemoryRouter initialEntries={['/person/arthur-alder']}>
        <ArchiveProvider
          siteConfig={siteConfig}
          loader={loader}
          initialBundle={null}
          session={session}
          plugins={[plugin]}
        >
          <ReloadArchiveTrigger />
          <Link to="/place/oakridge-ohio" data-testid="go-place">
            Go Place
          </Link>
          <Routes>
            <Route
              path="/person/:slug"
              element={<PluginSlot name="personDetail" person={deceasedPerson} />}
            />
            <Route path="/place/:slug" element={<div>Place View</div>} />
          </Routes>
          <PluginSlot name="appShell" />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // 1. Private-mode unauthenticated gate (bundle === null, anonymous): zero config calls, zero beacons, zero badges
    await act(async () => {
      root.render(renderWithState(anonSession));
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(configCalls).toBe(0);
    expect(beacons).toEqual([]);
    expect(container.querySelector('[data-testid="page-visit-badge-person"]')).toBeNull();

    // 2. User signs in & archive loads -> provider re-hydrates showPublicBadges=true from /api/observability/config and records landing beacon
    isAuthed = true;
    await act(async () => {
      root.render(renderWithState(memberSession));
      container.querySelector<HTMLButtonElement>('[data-testid="reload-archive-btn"]')?.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(configCalls).toBe(1);
    expect(container.querySelector('[data-testid="page-visit-badge-person"]')?.textContent).toBe('11 visits');
    expect(beacons).toEqual(['/person/arthur-alder']);

    // 3. SPA client-side navigation fires beacon for the new route
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="go-place"]');
    await act(async () => {
      link?.click();
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(beacons).toEqual(['/person/arthur-alder', '/place/oakridge-ohio']);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('synchronizes show_public_visit_badges bidirectionally via PluginSettingsBus between AdminPage and ObservabilityStats', async () => {
    let persistedBadges = false;
    let getPluginSettingsCount = 0;
    let getDiagnosticsCount = 0;

    const buildSnapshot = (enabled: boolean): PluginSettingsSnapshot => ({
      plugin_id: OBSERVABILITY_STATS_SERVER_PLUGIN_ID,
      plugin_name: 'Page Visit Stats',
      plugin_version: '0.54.2',
      status: 'active',
      schema: {
        title: 'Page Visit Stats',
        sections: [
          {
            id: 'display_preferences',
            title: 'Display Preferences',
            fields: [
              {
                key: 'show_public_visit_badges',
                label: 'Show public visit counts on entity pages',
                type: 'boolean',
                defaultValue: false,
              },
            ],
          },
        ],
      },
      values: { show_public_visit_badges: enabled },
      secrets: {},
      readonly_values: {},
      updated_at: '2026-11-27T12:00:00.000Z',
      updated_by: 'admin@archive.example',
    });

    const statsClient: ObservabilityStatsClient = {
      async getAdminStats() {
        return {
          generated_at: '2026-11-27T12:00:00.000Z',
          window: '30d',
          privacy_mode: 'aggregate-cookie-free',
          public_badges_enabled: persistedBadges,
          bundle_revision: 1,
          workers_observability_paired: false,
          totals: { views_7d: 3, views_30d: 3, views_all_time: 3 },
          cache: { hits: 0, misses: 0, not_modified: 0, total_requests: 0, hit_ratio: null },
          daily_trend: [{ day_utc: '2026-11-27', views: 3 }],
          top_pages: [],
          top_by_kind: { people: [], places: [], narratives: [] },
        };
      },
      async setPublicBadgesEnabled(enabled) {
        persistedBadges = enabled;
        return enabled;
      },
      async getPublicConfig() {
        return { enabled: true, public_badges_enabled: persistedBadges, record_spa_beacons: true };
      },
      async getPublicPageVisitCount(params) {
        return {
          route_key: `/${params.kind}/${params.slug}`,
          entity_kind: params.kind,
          entity_slug: params.slug,
          total_views: 4,
        };
      },
    };

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
      async getSystemDiagnostics() {
        getDiagnosticsCount += 1;
        return null as unknown as ReturnType<NonNullable<AdminDataSource['getSystemDiagnostics']>>;
      },
      async getPluginSettings() {
        getPluginSettingsCount += 1;
        return [buildSnapshot(persistedBadges)];
      },
      async updatePluginSettings(_pluginId, input) {
        persistedBadges = Boolean(input.values?.show_public_visit_badges);
        return buildSnapshot(persistedBadges);
      },
    };

    const plugin = createObservabilityStatsPlugin({ client: statsClient, showPublicVisitBadges: false });
    const deceasedPerson = testBundle.people.find((p) => p.slug === 'arthur-alder') as Person;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/admin']}>
          <ArchiveProvider
            siteConfig={siteConfig}
            initialBundle={testBundle}
            plugins={[plugin]}
            capabilities={{ canManageSite: true }}
            session={{
              authenticated: true,
              principal_kind: 'user',
              role: 'admin',
              email: 'admin@archive.example',
              displayName: 'Archive Steward',
            }}
          >
            <AdminPage adminClient={adminClient} />
            <PluginSlot name="personDetail" person={deceasedPerson} />
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 40));
    });

    // Initially OFF everywhere
    const panelSwitch = () =>
      container.querySelector<HTMLInputElement>('[data-testid="obs-public-badges-switch"]');
    expect(panelSwitch()?.checked).toBe(false);
    expect(container.querySelector('[data-testid="page-visit-badge-person"]')).toBeNull();

    const diagBefore = getDiagnosticsCount;
    // Save ON in PluginSettingsSection -> ObservabilityStatsPanel switch & live PageVisitBadge flip ON immediately!
    const settingsCheckbox = container.querySelector<HTMLInputElement>(
      '[data-testid="plugin-settings-card-kinloom-page-visit-stats"] input[type="checkbox"]'
    );
    expect(settingsCheckbox).not.toBeNull();
    await act(async () => {
      settingsCheckbox?.click();
    });
    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="plugin-settings-card-kinloom-page-visit-stats"] button[type="submit"]'
    );
    expect(saveBtn).not.toBeNull();
    await act(async () => {
      saveBtn?.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(panelSwitch()?.checked).toBe(true);
    expect(container.querySelector('[data-testid="page-visit-badge-person"]')?.textContent).toBe('4 visits');
    expect(getDiagnosticsCount).toBeGreaterThan(diagBefore);

    // Toggle OFF inside ObservabilityStatsPanel -> AdminPage reloads pluginSettings via PluginSettingsBus!
    const settingsCountBefore = getPluginSettingsCount;
    await act(async () => {
      panelSwitch()?.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(getPluginSettingsCount).toBeGreaterThan(settingsCountBefore);
    expect(container.querySelector('[data-testid="page-visit-badge-person"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('exercises HTTP observabilityStatsClient getPublicConfig, recordPageVisit, and credentials option', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url.endsWith('/api/observability/config')) {
        return new Response(
          JSON.stringify({ enabled: true, public_badges_enabled: true, record_spa_beacons: true }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(null, { status: 204 });
    });

    const httpClient = createHttpObservabilityStatsClient({
      apiBaseUrl: 'https://api.archive.example',
      credentials: 'include',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const cfg = await httpClient.getPublicConfig?.({ cache: 'no-store' });
    expect(cfg).toEqual({ enabled: true, public_badges_enabled: true, record_spa_beacons: true });
    expect(calls[0]?.url).toBe('https://api.archive.example/api/observability/config');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');

    await httpClient.recordPageVisit?.('/person/arthur-alder');
    expect(calls[1]?.url).toBe('https://api.archive.example/api/observability/page-visits/beacon');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(calls[1]?.init?.credentials).toBe('include');
    expect(calls[1]?.init?.keepalive).toBe(true);
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ path: '/person/arthur-alder' }));

    // Blank path skips network call; non-200 and network errors return null / swallow errors safely
    await httpClient.recordPageVisit?.('   ');
    expect(calls).toHaveLength(2);

    const errorClient = createHttpObservabilityStatsClient({
      apiBaseUrl: 'https://api.archive.example',
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/observability/config')) {
          return new Response(null, { status: 401 });
        }
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    expect(await errorClient.getPublicConfig?.()).toBeNull();
    await expect(errorClient.recordPageVisit?.('/tree')).resolves.toBeUndefined();

    const throwingConfigClient = createHttpObservabilityStatsClient({
      fetchImpl: (async () => {
        throw new Error('network error');
      }) as unknown as typeof fetch,
    });
    expect(await throwingConfigClient.getPublicConfig?.()).toBeNull();
  });

  it('skips SPA beacons when disabled, hidden, or matching the initial server HTML path, and falls back to getPublicConfig on snapshotless bus events', async () => {
    const beacons: string[] = [];
    let configCalls = 0;
    let shouldThrowConfig = false;
    let recordSpaBeaconsFlag = false;

    const edgeClient: ObservabilityStatsClient = {
      async getAdminStats() {
        return null;
      },
      async setPublicBadgesEnabled(next) {
        return next;
      },
      async getPublicPageVisitCount() {
        return null;
      },
      async getPublicConfig() {
        configCalls += 1;
        if (shouldThrowConfig) {
          throw new Error('temporary outage');
        }
        return {
          enabled: true,
          public_badges_enabled: true,
          record_spa_beacons: recordSpaBeaconsFlag,
        };
      },
      async recordPageVisit(path) {
        beacons.push(path);
      },
    };

    const originalPathname = window.location.pathname;
    window.history.replaceState({}, '', '/places');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const plugin = createObservabilityStatsPlugin({ client: edgeClient });

    // 1. recordSpaBeacons === false skips beacon
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/places']}>
          <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle}>
            <KinloomPluginProvider plugins={[plugin]}>
              <PluginSlot name="appShell" />
              <SnapshotlessBusTrigger />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(beacons).toEqual([]);

    // 2. Snapshotless PluginSettingsBus event triggers fallback getPublicConfig (and handles errors)
    const callsBeforeNotify = configCalls;
    shouldThrowConfig = true;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="trigger-snapshotless-bus"]')?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(configCalls).toBe(callsBeforeNotify + 1);

    // 3. Re-enable recordSpaBeacons: initial load matching window.location.pathname ('/places') is deduplicated
    shouldThrowConfig = false;
    recordSpaBeaconsFlag = true;
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/places']}>
          <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle}>
            <KinloomPluginProvider plugins={[createObservabilityStatsPlugin({ client: edgeClient })]}>
              <PluginSlot name="appShell" />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(beacons).toEqual([]);

    // 4. Hidden visibilityState suppresses beacons even on a non-initial route
    const origVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/tree']}>
          <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle}>
            <KinloomPluginProvider plugins={[createObservabilityStatsPlugin({ client: edgeClient })]}>
              <PluginSlot name="appShell" />
            </KinloomPluginProvider>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(beacons).toEqual([]);

    if (origVisibility) {
      Object.defineProperty(document, 'visibilityState', origVisibility);
    } else {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    window.history.replaceState({}, '', originalPathname);
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
