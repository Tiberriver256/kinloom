import type { AdminDiagnosticsReport } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  buildGitHubBugReportUrl,
  type ClientEnvironmentSnapshot,
  formatBytesCompact,
  formatDiagnosticsMarkdown,
  GITHUB_BUG_REPORT_BASE_URL,
  mergePluginDiagnostics,
  parseClientUserAgent,
  redactDiagnosticText,
} from './adminDiagnostics.js';

const SAMPLE_REPORT: AdminDiagnosticsReport = {
  generated_at: '2026-11-27T12:00:00.000Z',
  versions: {
    core_version: '0.42.0',
    server_version: '0.42.0',
    worker_version: '0.42.0',
    build_commit_sha: 'abcdef1',
    build_timestamp: '2026-11-27T11:00:00Z',
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
      security_telemetry: false,
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
    head_revision_id: 14,
    bundle_cache_status: 'hit',
    counts: {
      people_deceased: 42,
      people_living: 3,
      events: 90,
      places: 18,
      sources: 25,
      media: 12,
      narratives: 4,
    },
  },
  health_checks: [
    { name: 'repository', status: 'pass', latency_ms: 2.4, detail: 'Head revision r14' },
    { name: 'bundle_cache', status: 'pass', latency_ms: 1.1, detail: 'Cached at r14' },
    { name: 'media_store', status: 'pass', latency_ms: 0.8, detail: 'Reachable' },
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
  ],
  recent_errors: [
    {
      timestamp: '2026-11-27T11:55:00.000Z',
      route: '/api/entities/:type/:id',
      status: 404,
      error_code: 'NOT_FOUND',
    },
  ],
};

const SAMPLE_CLIENT: ClientEnvironmentSnapshot = {
  ui_version: '0.42.0',
  browser_summary: 'Chromium 135',
  os_summary: 'Linux',
  viewport: '1440x900',
  device_pixel_ratio: 2,
  origin_mode: 'omitted',
};

describe('adminDiagnostics pure helpers', () => {
  it('parses coarse browser and OS families from user agent strings', () => {
    expect(parseClientUserAgent('')).toEqual({ browser: 'Unknown', os: 'Unknown' });
    expect(
      parseClientUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36'
      )
    ).toEqual({ browser: 'Chromium 135', os: 'Linux' });
    expect(
      parseClientUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/135.0.0.0 Edg/135.0.0.0')
    ).toEqual({ browser: 'Edge 135', os: 'Windows' });
    expect(
      parseClientUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:136.0) Gecko/20100101 Firefox/136.0'
      )
    ).toEqual({ browser: 'Firefox 136', os: 'macOS' });
    expect(
      parseClientUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) Version/18.3 Safari/604.1')
    ).toEqual({ browser: 'Safari 18.3', os: 'iOS' });
    expect(
      parseClientUserAgent('Mozilla/5.0 (Linux; Android 15) Chrome/134.0.0.0 Mobile Safari/537.36')
    ).toEqual({
      browser: 'Chromium 134',
      os: 'Android',
    });
  });

  it('formats byte sizes and redacts emails, bearer tokens, cookies, and query secrets', () => {
    expect(formatBytesCompact(-1)).toBe('0 B');
    expect(formatBytesCompact(512)).toBe('512 B');
    expect(formatBytesCompact(2048)).toBe('2 KB');
    expect(formatBytesCompact(1536)).toBe('1.5 KB');
    expect(formatBytesCompact(15 * 1024 * 1024)).toBe('15 MB');
    expect(formatBytesCompact(1.5 * 1024 * 1024)).toBe('1.5 MB');

    const scrubbed = redactDiagnosticText(
      'user=steward@example.com Bearer abc.def.ghi __Host-kinloom_session=xyz123 ?token=secret99 klm_abcdefghijklmnop'
    );
    expect(scrubbed).not.toContain('steward@example.com');
    expect(scrubbed).not.toContain('abc.def.ghi');
    expect(scrubbed).not.toContain('xyz123');
    expect(scrubbed).not.toContain('secret99');
    expect(scrubbed).not.toContain('klm_abcdefghijklmnop');
  });

  it('merges server and UI plugins deterministically and formats collapsible Markdown', () => {
    const merged = mergePluginDiagnostics(SAMPLE_REPORT.plugins, [
      {
        id: 'kinloom-narrative-audio',
        name: 'Narrative Audio',
        version: '0.42.0',
        status: 'active',
        routeCount: 0,
        hooks: ['provider', 'slot:appShell'],
      },
      {
        id: 'custom-unversioned',
        name: 'Custom Plugin',
        routeCount: 1,
        hooks: [],
      },
    ]);
    expect(merged.map((p) => `${p.surface}:${p.id}:${p.version}:${p.status}`)).toEqual([
      'server:kinloom-workers-observability:0.42.0:active',
      'ui:custom-unversioned:unversioned:active',
      'ui:kinloom-narrative-audio:0.42.0:active',
    ]);

    const md = formatDiagnosticsMarkdown({
      report: SAMPLE_REPORT,
      client: SAMPLE_CLIENT,
      mergedPlugins: merged,
    });
    expect(md.startsWith('<details>\n<summary>Kinloom Diagnostics</summary>')).toBe(true);
    expect(md.endsWith('</details>')).toBe(true);
    expect(md).toContain('Server version: `0.42.0`');
    expect(md).toContain('origin `omitted`');
    expect(md).toContain('`kinloom-narrative-audio`');
    expect(md).toContain('`NOT_FOUND`');

    const emptyMd = formatDiagnosticsMarkdown({
      report: { ...SAMPLE_REPORT, plugins: [], recent_errors: [] },
      client: SAMPLE_CLIENT,
      mergedPlugins: [],
    });
    expect(emptyMd).toContain('- None registered.');
    expect(emptyMd).toContain('- No recent server errors recorded in this runtime process.');
  });

  it('builds pre-filled GitHub bug-report URLs and falls back safely when exceeding URL limits', () => {
    const md = formatDiagnosticsMarkdown({
      report: SAMPLE_REPORT,
      client: SAMPLE_CLIENT,
      mergedPlugins: SAMPLE_REPORT.plugins,
    });

    const prefilled = buildGitHubBugReportUrl({
      report: SAMPLE_REPORT,
      client: SAMPLE_CLIENT,
      markdown: md,
    });
    expect(prefilled.diagnosticsIncludedInUrl).toBe(true);
    expect(prefilled.url.startsWith(`${GITHUB_BUG_REPORT_BASE_URL}?`)).toBe(true);
    const parsedUrl = new URL(prefilled.url);
    expect(parsedUrl.searchParams.get('template')).toBe('bug_report.yml');
    expect(parsedUrl.searchParams.get('environment')).toContain('kinloom 0.42.0');
    expect(parsedUrl.searchParams.get('description')).toContain('<details>');

    const fallback = buildGitHubBugReportUrl({
      report: {
        ...SAMPLE_REPORT,
        runtime: { ...SAMPLE_REPORT.runtime, platform: 'node', node_version: '24.1.0' },
      },
      client: SAMPLE_CLIENT,
      markdown: md,
      maxUrlLength: 350,
    });
    expect(fallback.diagnosticsIncludedInUrl).toBe(false);
    const fallbackParsed = new URL(fallback.url);
    expect(fallbackParsed.searchParams.get('environment')).toContain('Node 24.1.0');
    expect(fallbackParsed.searchParams.get('description')).toContain('Paste the copied Kinloom Diagnostics');
  });
});
