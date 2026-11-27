import { z } from 'zod';

export const PluginRuntimeStatusSchema = z.enum(['active', 'disabled', 'degraded']);
export type PluginRuntimeStatus = z.infer<typeof PluginRuntimeStatusSchema>;

export const PluginSurfaceSchema = z.enum(['server', 'ui']);
export type PluginSurface = z.infer<typeof PluginSurfaceSchema>;

export const PluginStatusProbeResultSchema = z.object({
  status: PluginRuntimeStatusSchema,
  detail: z.string().optional(),
});
export type PluginStatusProbeResult = z.infer<typeof PluginStatusProbeResultSchema>;

export const PluginStatusRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  status: PluginRuntimeStatusSchema,
  surface: PluginSurfaceSchema,
  route_count: z.number().int().nonnegative(),
  hooks: z.array(z.string().min(1)),
  detail: z.string().nullable().default(null),
});
export type PluginStatusRecord = z.infer<typeof PluginStatusRecordSchema>;

export const HealthCheckNameSchema = z.enum(['repository', 'bundle_cache', 'media_store']);
export type HealthCheckName = z.infer<typeof HealthCheckNameSchema>;

export const HealthCheckStatusSchema = z.enum(['pass', 'warn', 'fail']);
export type HealthCheckStatus = z.infer<typeof HealthCheckStatusSchema>;

export const HealthCheckResultSchema = z.object({
  name: HealthCheckNameSchema,
  status: HealthCheckStatusSchema,
  latency_ms: z.number().nonnegative(),
  detail: z.string().nullable().default(null),
});
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

export const DiagnosticErrorSummarySchema = z.object({
  timestamp: z.string().min(1),
  route: z.string().min(1),
  status: z.number().int().min(400).max(599),
  error_code: z.string().min(1),
});
export type DiagnosticErrorSummary = z.infer<typeof DiagnosticErrorSummarySchema>;

export const DiagnosticsVersionsSchema = z.object({
  core_version: z.string().min(1),
  server_version: z.string().min(1),
  worker_version: z.string().min(1).nullable().default(null),
  build_commit_sha: z.string().min(1).nullable().default(null),
  build_timestamp: z.string().min(1).nullable().default(null),
  schema_migration_level: z.string().min(1).nullable().default(null),
});
export type DiagnosticsVersions = z.infer<typeof DiagnosticsVersionsSchema>;

export const DiagnosticsPlatformSchema = z.enum(['cloudflare-workers', 'node', 'unknown']);
export type DiagnosticsPlatform = z.infer<typeof DiagnosticsPlatformSchema>;

export const DiagnosticsAdaptersSchema = z.object({
  repository: z.string().min(1),
  bundle_cache: z.string().min(1),
  media_store: z.string().min(1),
  email_sender: z.string().min(1),
  auth_provider_configured: z.boolean(),
  auth_provider_id: z.string().min(1).nullable().default(null),
  pronunciation_generator: z.string().min(1),
  pronunciation_lexicon_store: z.string().min(1),
});
export type DiagnosticsAdapters = z.infer<typeof DiagnosticsAdaptersSchema>;

export const DiagnosticsRuntimeSchema = z.object({
  platform: DiagnosticsPlatformSchema,
  node_version: z.string().min(1).nullable().default(null),
  workers_compatibility_date: z.string().min(1).nullable().default(null),
  adapters: DiagnosticsAdaptersSchema,
});
export type DiagnosticsRuntime = z.infer<typeof DiagnosticsRuntimeSchema>;

export const DiagnosticsConfigFlagsSchema = z.object({
  mode: z.enum(['private', 'public']),
  read_only_demo: z.boolean(),
  auth_methods: z.object({
    google_oauth: z.boolean(),
    magic_link: z.boolean(),
    invite_links: z.boolean(),
    agent_tokens: z.boolean(),
  }),
  observability: z.object({
    enabled: z.boolean(),
    server_timing: z.boolean(),
    security_telemetry: z.boolean(),
    web_analytics: z.boolean(),
  }),
  wiki: z.object({
    allow_talk: z.boolean(),
    allow_watchlists: z.boolean(),
    max_upload_bytes: z.number().int().positive(),
  }),
  privacy: z.object({
    living_cutoff_years: z.number().int().min(1).max(150),
    private_mode_shows_birth_year: z.boolean(),
    strip_living_portraits: z.boolean(),
    strip_living_residence_spans: z.boolean(),
    mark_gedcom_living_confidential: z.boolean(),
  }),
});
export type DiagnosticsConfigFlags = z.infer<typeof DiagnosticsConfigFlagsSchema>;

export const DiagnosticsArchiveStatsSchema = z.object({
  head_revision_id: z.number().int().nonnegative(),
  bundle_cache_status: z.enum(['hit', 'miss', 'error']),
  counts: z.object({
    people_deceased: z.number().int().nonnegative(),
    people_living: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    places: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    media: z.number().int().nonnegative(),
    narratives: z.number().int().nonnegative(),
  }),
});
export type DiagnosticsArchiveStats = z.infer<typeof DiagnosticsArchiveStatsSchema>;

export const AdminDiagnosticsReportSchema = z.object({
  generated_at: z.string().min(1),
  versions: DiagnosticsVersionsSchema,
  runtime: DiagnosticsRuntimeSchema,
  config: DiagnosticsConfigFlagsSchema,
  archive: DiagnosticsArchiveStatsSchema,
  health_checks: z.array(HealthCheckResultSchema),
  plugins: z.array(PluginStatusRecordSchema),
  recent_errors: z.array(DiagnosticErrorSummarySchema),
});
export type AdminDiagnosticsReport = z.infer<typeof AdminDiagnosticsReportSchema>;
