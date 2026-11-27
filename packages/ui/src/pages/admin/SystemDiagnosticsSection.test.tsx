/** @vitest-environment jsdom */
import type {
  AdminDataSource,
  AdminDiagnosticsReport,
  ArchiveBundle,
  ArchiveDataSource,
  KinloomSiteConfig,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpWikiDataSource } from '../../adapters/httpWikiDataSource.js';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { createNarrativeAudioPlugin } from '../../plugins/narrativeAudioPlugin.js';
import { KinloomPluginProvider } from '../../plugins/PluginContext.js';
import type { KinloomUiPlugin } from '../../plugins/types.js';
import { KINLOOM_UI_VERSION } from '../../version.js';
import { AdminPage } from '../AdminPage.js';
import { SystemDiagnosticsSection } from './SystemDiagnosticsSection.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Diagnostics Archive',
    familyName: 'Vance Family',
    gedcomSourceName: 'DIAG_UI_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'private',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

const SAMPLE_DIAGNOSTICS: AdminDiagnosticsReport = {
  generated_at: '2026-11-27T12:00:00.000Z',
  versions: {
    core_version: '0.42.0',
    server_version: '0.42.0',
    worker_version: '0.42.0',
    build_commit_sha: 'abc1234',
    build_timestamp: '2026-11-27T11:30:00Z',
    schema_migration_level: '0003_pronunciation_provenance.sql',
  },
  runtime: {
    platform: 'cloudflare-workers',
    node_version: null,
    workers_compatibility_date: '2026-08-06',
    adapters: {
      repository: 'd1',
      bundle_cache: 'r2',
      media_store: 'r2',
      email_sender: 'cloudflare-email',
      auth_provider_configured: true,
      auth_provider_id: 'google',
      pronunciation_generator: 'gemini-tts',
      pronunciation_lexicon_store: 'd1',
    },
  },
  config: {
    mode: 'private',
    read_only_demo: false,
    auth_methods: {
      google_oauth: true,
      magic_link: true,
      invite_links: true,
      agent_tokens: true,
    },
    observability: {
      enabled: true,
      server_timing: true,
      security_telemetry: true,
      web_analytics: false,
    },
    wiki: {
      allow_talk: true,
      allow_watchlists: false,
      max_upload_bytes: 15_728_640,
    },
    privacy: {
      living_cutoff_years: 101,
      private_mode_shows_birth_year: true,
      strip_living_portraits: true,
      strip_living_residence_spans: true,
      mark_gedcom_living_confidential: true,
    },
  },
  archive: {
    head_revision_id: 9,
    bundle_cache_status: 'hit',
    counts: {
      people_deceased: 18,
      people_living: 2,
      events: 24,
      places: 7,
      sources: 11,
      media: 5,
      narratives: 2,
    },
  },
  health_checks: [
    { name: 'repository', status: 'pass', latency_ms: 1.8, detail: 'Head revision r9' },
    { name: 'bundle_cache', status: 'warn', latency_ms: 2.3, detail: 'Cache cold' },
    { name: 'media_store', status: 'fail', latency_ms: 4.1, detail: 'Media store probe failed' },
  ],
  plugins: [
    {
      id: 'kinloom-workers-observability',
      name: 'Cloudflare Workers Observability',
      version: '0.42.0',
      status: 'active',
      surface: 'server',
      route_count: 0,
      hooks: ['onRequestStart', 'onResponse'],
      detail: 'server-timing, request-id',
    },
    {
      id: 'broken-probe-plugin',
      name: 'Broken Probe Plugin',
      version: '1.0.0',
      status: 'degraded',
      surface: 'server',
      route_count: 1,
      hooks: [],
      detail: 'Status probe threw an error',
    },
  ],
  recent_errors: [
    {
      timestamp: '2026-11-27T11:58:00.000Z',
      route: '/api/entities/:type/:id',
      status: 404,
      error_code: 'NOT_FOUND',
    },
  ],
};

const cleanups: Array<() => void> = [];

function mountEl(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('Admin Settings & SystemDiagnosticsSection behavioral flows', () => {
  it('parses GET /api/admin/system strictly via HttpWikiDataSource and rejects malformed payloads', async () => {
    const validDs = createHttpWikiDataSource({
      fetchImpl: async () =>
        new Response(JSON.stringify(SAMPLE_DIAGNOSTICS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const parsed = await validDs.admin.getSystemDiagnostics?.();
    expect(parsed?.versions.server_version).toBe('0.42.0');
    expect(parsed?.plugins).toHaveLength(2);

    const invalidDs = createHttpWikiDataSource({
      fetchImpl: async () =>
        new Response(JSON.stringify({ versions: { server_version: 123 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(invalidDs.admin.getSystemDiagnostics?.()).rejects.toMatchObject({
      code: 'INVALID_API_RESPONSE',
    });
  });

  it('renders merged server + UI plugins, adminSettings slot, copy feedback, GitHub link, and refresh in AdminPage', async () => {
    const copiedPayloads: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedPayloads.push(text);
        },
      },
    });

    let diagnosticsCalls = 0;
    const adminClient: AdminDataSource = {
      listUsers: async () => [
        {
          email: 'steward@archive.example',
          display_name: 'Archive Steward',
          role: 'admin',
          added_by: 'bootstrap',
          added_at: '2026-01-01T00:00:00Z',
          last_login_at: null,
        },
      ],
      updateUserRole: async (_email, _input) => {
        throw new Error('not used');
      },
      listInvites: async () => [],
      createInvite: async () => {
        throw new Error('not used');
      },
      revokeInvite: async () => {},
      listAgentTokens: async () => [],
      createAgentToken: async () => {
        throw new Error('not used');
      },
      revokeAgentToken: async () => {},
      getSystemDiagnostics: async () => {
        diagnosticsCalls += 1;
        return SAMPLE_DIAGNOSTICS;
      },
    };

    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
      admin: adminClient,
    };

    const settingsExtensionPlugin: KinloomUiPlugin = {
      id: 'ext-admin-panel',
      name: 'Observability Extension Panel',
      version: '1.4.0',
      status: 'active',
      slots: {
        adminSettings: () => <section data-testid="plugin-admin-settings-slot">Plugin Settings Slot</section>,
      },
    };

    const container = mountEl(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          initialBundle={SAMPLE_BUNDLE}
          dataSource={dataSource}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'steward@archive.example',
            displayName: 'Archive Steward',
            role: 'admin',
          }}
          capabilities={{ canEdit: true, canManageSite: true, canUploadMedia: true }}
        >
          <KinloomPluginProvider plugins={[createNarrativeAudioPlugin(), settingsExtensionPlugin]}>
            <AdminPage extraSettingsPanels={<div data-testid="extra-settings-panel">Future Panel</div>} />
          </KinloomPluginProvider>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(diagnosticsCalls).toBe(1);
    expect(container.textContent).toContain('Core Application Settings & Diagnostics');
    expect(container.textContent).toContain('Cloudflare Workers Observability');
    expect(container.textContent).toContain('Broken Probe Plugin');
    expect(container.textContent).toContain('Narrative Audio');
    expect(container.textContent).toContain('Observability Extension Panel');
    expect(container.textContent).toContain(KINLOOM_UI_VERSION);
    expect(container.textContent).toContain('NOT_FOUND');
    expect(container.querySelector('[data-testid="plugin-admin-settings-slot"]')?.textContent).toBe(
      'Plugin Settings Slot'
    );
    expect(container.querySelector('[data-testid="extra-settings-panel"]')?.textContent).toBe('Future Panel');

    const copyBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Copy Diagnostics for GitHub Issue')
    );
    expect(copyBtn).toBeDefined();

    await act(async () => {
      copyBtn?.click();
      await Promise.resolve();
    });
    expect(copiedPayloads).toHaveLength(1);
    expect(copiedPayloads[0]).toContain('<details>');
    expect(copiedPayloads[0]).toContain('kinloom-narrative-audio');
    expect(copiedPayloads[0]).not.toContain('steward@archive.example');

    const statusLiveRegion = container.querySelector('[role="status"]');
    expect(statusLiveRegion?.textContent).toBe('Copied');

    // Second click appends a no-break space so VoiceOver announces repeat copy confirmations.
    await act(async () => {
      copyBtn?.click();
      await Promise.resolve();
    });
    expect(statusLiveRegion?.textContent).toBe('Copied\u00A0');

    const ghLink = container.querySelector<HTMLAnchorElement>(
      'a[href*="github.com/Tiberriver256/kinloom/issues/new"]'
    );
    expect(ghLink).not.toBeNull();
    expect(ghLink?.href).toContain('template=bug_report.yml');

    const refreshBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Refresh Diagnostics')
    );
    await act(async () => {
      refreshBtn?.click();
      await Promise.resolve();
    });
    expect(diagnosticsCalls).toBe(2);
  });

  it('handles clipboard failure, long-URL fallback notice, and diagnostics load error cleanly', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard denied');
        },
      },
    });

    const container = mountEl(
      <KinloomPluginProvider plugins={[]}>
        <SystemDiagnosticsSection
          report={{ ...SAMPLE_DIAGNOSTICS, plugins: [], recent_errors: [] }}
          loading={false}
          error="Diagnostics timeout"
          supported={true}
          onRefresh={async () => {}}
          maxIssueUrlLength={250}
        />
      </KinloomPluginProvider>
    );
    await flushUi();

    expect(container.textContent).toContain('Could not load system diagnostics: Diagnostics timeout');
    expect(container.textContent).toContain('too long to pre-fill in the GitHub URL');
    expect(container.textContent).toContain('No server or UI plugins are currently registered.');
    expect(container.textContent).toContain('No server errors recorded in this runtime process.');

    const copyBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Copy Diagnostics for GitHub Issue')
    );
    await act(async () => {
      copyBtn?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Copy failed');
  });
});
