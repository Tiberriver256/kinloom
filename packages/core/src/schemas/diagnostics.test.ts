import { describe, expect, it } from 'vitest';
import {
  AdminDiagnosticsReportSchema,
  DiagnosticErrorSummarySchema,
  HealthCheckResultSchema,
  KINLOOM_CORE_VERSION,
  PluginRuntimeStatusSchema,
  PluginStatusRecordSchema,
} from '../index.js';

describe('diagnostics schemas and version contract', () => {
  it('exports a valid semver KINLOOM_CORE_VERSION', () => {
    expect(KINLOOM_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('parses a complete AdminDiagnosticsReport and applies nullable defaults', () => {
    const parsed = AdminDiagnosticsReportSchema.parse({
      generated_at: '2026-11-27T12:00:00.000Z',
      versions: {
        core_version: '0.42.0',
        server_version: '0.42.0',
      },
      runtime: {
        platform: 'node',
        adapters: {
          repository: 'in-memory',
          bundle_cache: 'in-memory',
          media_store: 'in-memory',
          email_sender: 'in-memory',
          auth_provider_configured: false,
          pronunciation_generator: 'none',
          pronunciation_lexicon_store: 'in-memory',
        },
      },
      config: {
        mode: 'private',
        read_only_demo: false,
        auth_methods: {
          google_oauth: false,
          magic_link: true,
          invite_links: true,
          agent_tokens: true,
        },
        observability: {
          enabled: false,
          server_timing: false,
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
        head_revision_id: 4,
        bundle_cache_status: 'hit',
        counts: {
          people_deceased: 12,
          people_living: 2,
          events: 15,
          places: 6,
          sources: 8,
          media: 3,
          narratives: 1,
        },
      },
      health_checks: [{ name: 'repository', status: 'pass', latency_ms: 1.5 }],
      plugins: [
        {
          id: 'kinloom-workers-observability',
          name: 'Cloudflare Workers Observability',
          version: '0.42.0',
          status: 'active',
          surface: 'server',
          route_count: 0,
          hooks: ['onRequestStart', 'onResponse'],
        },
      ],
      recent_errors: [
        {
          timestamp: '2026-11-27T11:59:00.000Z',
          route: '/api/entities/:type/:id',
          status: 404,
          error_code: 'NOT_FOUND',
        },
      ],
    });

    expect(parsed.versions.worker_version).toBeNull();
    expect(parsed.versions.build_commit_sha).toBeNull();
    expect(parsed.runtime.node_version).toBeNull();
    expect(parsed.health_checks[0]?.detail).toBeNull();
    expect(parsed.plugins[0]?.detail).toBeNull();
  });

  it('rejects invalid plugin status, health status, and non-error HTTP status codes', () => {
    expect(PluginRuntimeStatusSchema.safeParse('unknown').success).toBe(false);
    expect(
      PluginStatusRecordSchema.safeParse({
        id: 'p1',
        name: 'Plugin',
        version: '1.0.0',
        status: 'active',
        surface: 'cli',
        route_count: 0,
        hooks: [],
      }).success
    ).toBe(false);
    expect(
      HealthCheckResultSchema.safeParse({
        name: 'repository',
        status: 'ok',
        latency_ms: 1,
      }).success
    ).toBe(false);
    expect(
      DiagnosticErrorSummarySchema.safeParse({
        timestamp: '2026-11-27T12:00:00Z',
        route: '/api/bundle',
        status: 200,
        error_code: 'OK',
      }).success
    ).toBe(false);
  });
});
