/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, Narrative, Person, Place } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ObservabilityStatsClient } from '../adapters/observabilityStatsClient.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import type {
  UiAdminObservabilityStats,
  UiObservabilityStatsWindow,
} from '../lib/observabilityStatsModel.js';
import { AdminSettingsShell } from '../pages/admin/AdminSettingsShell.js';
import {
  createObservabilityStatsPlugin,
  OBSERVABILITY_STATS_UI_PLUGIN_ID,
} from './observabilityStatsPlugin.js';
import { KinloomPluginProvider, PluginSlot } from './PluginContext.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
    expect(container.querySelector('[data-testid="page-visit-badge-narrative"]')?.textContent).toBe(
      '7 visits'
    );

    // Living person and living-linked narrative never trigger any network call or badge render!
    expect(queriedSlugs).toEqual(['person:arthur-alder', 'place:oakridge-ohio', 'narrative:oakridge-mill']);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
