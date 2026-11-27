import type { AdminDiagnosticsReport, PluginRuntimeStatus, PluginStatusRecord } from '@kinloom/core';

export const GITHUB_BUG_REPORT_BASE_URL = 'https://github.com/Tiberriver256/kinloom/issues/new';
export const DEFAULT_MAX_GITHUB_ISSUE_URL_LENGTH = 6000;

export interface ClientEnvironmentSnapshot {
  readonly ui_version: string;
  readonly browser_summary: string;
  readonly os_summary: string;
  readonly viewport: string;
  readonly device_pixel_ratio: number;
  readonly origin_mode: 'omitted';
}

export interface UiPluginDiagnosticInput {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly status?: PluginRuntimeStatus;
  readonly routeCount: number;
  readonly hooks: readonly string[];
}

export interface GitHubBugReportLinkResult {
  readonly url: string;
  readonly diagnosticsIncludedInUrl: boolean;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_RE = /\b(?:kin|klm|inv|tok|sess)_[A-Za-z0-9._-]{8,}\b/gi;
const COOKIE_RE = /\b(?:__Host-)?kinloom_(?:session|oauth)=[^;\s]+/gi;
const QUERY_SECRET_RE = /([?&](?:token|code|state|secret|email|invite|api_key|key)=)[^&\s#]+/gi;

export function redactDiagnosticText(raw: string): string {
  return raw
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(COOKIE_RE, '[REDACTED_COOKIE]')
    .replace(QUERY_SECRET_RE, '$1[REDACTED]')
    .replace(TOKEN_RE, '[REDACTED_TOKEN]')
    .replace(EMAIL_RE, '[REDACTED_EMAIL]');
}

export function parseClientUserAgent(userAgent: string): { readonly browser: string; readonly os: string } {
  const ua = userAgent.trim();
  if (!ua) {
    return { browser: 'Unknown', os: 'Unknown' };
  }

  let os = 'Unknown';
  if (/iPhone|iPad|iPod/i.test(ua)) {
    os = 'iOS';
  } else if (/Android/i.test(ua)) {
    os = 'Android';
  } else if (/Windows NT/i.test(ua)) {
    os = 'Windows';
  } else if (/Mac OS X|Macintosh/i.test(ua)) {
    os = 'macOS';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }

  let browser = 'Unknown';
  const edgeMatch = /\bEdg\/(\d+)/.exec(ua);
  const firefoxMatch = /\bFirefox\/(\d+)/.exec(ua);
  const chromeMatch = /\b(?:Chrome|Chromium)\/(\d+)/.exec(ua);
  const safariMatch = /\bVersion\/(\d+(?:\.\d+)?)\s+.*Safari\//.exec(ua);

  if (edgeMatch) {
    browser = `Edge ${edgeMatch[1]}`;
  } else if (firefoxMatch) {
    browser = `Firefox ${firefoxMatch[1]}`;
  } else if (chromeMatch) {
    browser = `Chromium ${chromeMatch[1]}`;
  } else if (safariMatch) {
    browser = `Safari ${safariMatch[1]}`;
  }

  return { browser, os };
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
  }
  return `${Math.trunc(bytes)} B`;
}

export function mergePluginDiagnostics(
  serverPlugins: readonly PluginStatusRecord[],
  uiPlugins: readonly UiPluginDiagnosticInput[]
): readonly PluginStatusRecord[] {
  const uiRecords: PluginStatusRecord[] = uiPlugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version?.trim() ? plugin.version.trim() : 'unversioned',
    status: plugin.status ?? 'active',
    surface: 'ui',
    route_count: Math.max(0, Math.trunc(plugin.routeCount)),
    hooks: [...plugin.hooks],
    detail: null,
  }));

  return [...serverPlugins, ...uiRecords].toSorted(
    (left, right) => left.surface.localeCompare(right.surface) || left.id.localeCompare(right.id)
  );
}

function escapeMarkdownCell(value: string): string {
  return redactDiagnosticText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

export function formatDiagnosticsMarkdown(params: {
  readonly report: AdminDiagnosticsReport;
  readonly client: ClientEnvironmentSnapshot;
  readonly mergedPlugins: readonly PluginStatusRecord[];
}): string {
  const { report, client, mergedPlugins } = params;
  const { versions, runtime, config, archive, health_checks, recent_errors } = report;

  const lines: string[] = [
    '<details>',
    '<summary>Kinloom Diagnostics</summary>',
    '',
    '> Strictly redacted diagnostics bundle: zero secrets, tokens, emails, host/origin, or living-person records.',
    '',
    '### Versions & Build',
    `- UI version: \`${escapeMarkdownCell(client.ui_version)}\``,
    `- Server version: \`${escapeMarkdownCell(versions.server_version)}\``,
    `- Core version: \`${escapeMarkdownCell(versions.core_version)}\``,
    `- Worker version: \`${escapeMarkdownCell(versions.worker_version ?? 'n/a')}\``,
    `- Build commit SHA: \`${escapeMarkdownCell(versions.build_commit_sha ?? 'n/a')}\``,
    `- Build timestamp: \`${escapeMarkdownCell(versions.build_timestamp ?? 'n/a')}\``,
    `- Schema migration level: \`${escapeMarkdownCell(versions.schema_migration_level ?? 'n/a')}\``,
    `- Generated at: \`${escapeMarkdownCell(report.generated_at)}\``,
    '',
    '### Runtime & Storage Backends',
    `- Platform: \`${runtime.platform}\``,
    `- Node version: \`${escapeMarkdownCell(runtime.node_version ?? 'n/a')}\``,
    `- Workers compatibility date: \`${escapeMarkdownCell(runtime.workers_compatibility_date ?? 'n/a')}\``,
    `- Client: \`${escapeMarkdownCell(client.browser_summary)}\` on \`${escapeMarkdownCell(client.os_summary)}\` (\`${escapeMarkdownCell(client.viewport)}\`, DPR \`${client.device_pixel_ratio}\`, origin \`${client.origin_mode}\`)`,
    `- Repository adapter: \`${escapeMarkdownCell(runtime.adapters.repository)}\``,
    `- Bundle cache adapter: \`${escapeMarkdownCell(runtime.adapters.bundle_cache)}\``,
    `- Media store adapter: \`${escapeMarkdownCell(runtime.adapters.media_store)}\``,
    `- Email sender adapter: \`${escapeMarkdownCell(runtime.adapters.email_sender)}\``,
    `- OAuth provider: \`${runtime.adapters.auth_provider_configured ? escapeMarkdownCell(runtime.adapters.auth_provider_id ?? 'configured') : 'not configured'}\``,
    `- Pronunciation TTS backend: \`${escapeMarkdownCell(runtime.adapters.pronunciation_generator)}\``,
    `- Pronunciation lexicon store: \`${escapeMarkdownCell(runtime.adapters.pronunciation_lexicon_store)}\``,
    '',
    '### Live Health Checks',
    '| Check | Status | Latency (ms) | Detail |',
    '| --- | --- | ---: | --- |',
  ];

  for (const check of health_checks) {
    lines.push(
      `| \`${check.name}\` | \`${check.status}\` | ${check.latency_ms} | ${escapeMarkdownCell(check.detail ?? '—')} |`
    );
  }

  lines.push(
    '',
    '### Redacted Configuration Flags',
    `- Archive mode: \`${config.mode}\` (read-only demo: \`${config.read_only_demo}\`)`,
    `- Auth methods: Google OAuth=\`${config.auth_methods.google_oauth}\`, Magic Link=\`${config.auth_methods.magic_link}\`, Invites=\`${config.auth_methods.invite_links}\`, Agent Tokens=\`${config.auth_methods.agent_tokens}\``,
    `- Observability: enabled=\`${config.observability.enabled}\`, Server-Timing=\`${config.observability.server_timing}\`, Security Telemetry=\`${config.observability.security_telemetry}\`, Web Analytics=\`${config.observability.web_analytics}\``,
    `- Wiki: allow_talk=\`${config.wiki.allow_talk}\`, allow_watchlists=\`${config.wiki.allow_watchlists}\`, max_upload=\`${formatBytesCompact(config.wiki.max_upload_bytes)}\``,
    `- Privacy: living_cutoff_years=\`${config.privacy.living_cutoff_years}\`, strip_living_portraits=\`${config.privacy.strip_living_portraits}\`, strip_living_residence_spans=\`${config.privacy.strip_living_residence_spans}\`, mark_gedcom_living_confidential=\`${config.privacy.mark_gedcom_living_confidential}\``,
    '',
    '### Archive Aggregate Counts (Zero PII)',
    `- Head revision: \`r${archive.head_revision_id}\` (bundle cache: \`${archive.bundle_cache_status}\`)`,
    `- People: \`${archive.counts.people_deceased}\` deceased, \`${archive.counts.people_living}\` living`,
    `- Entities: \`${archive.counts.events}\` events, \`${archive.counts.places}\` places, \`${archive.counts.sources}\` sources, \`${archive.counts.media}\` media, \`${archive.counts.narratives}\` narratives`,
    '',
    '### Installed Plugins'
  );

  if (mergedPlugins.length === 0) {
    lines.push('- None registered.');
  } else {
    lines.push(
      '| Plugin | ID | Surface | Version | Status | Routes | Hooks / Detail |',
      '| --- | --- | --- | --- | --- | ---: | --- |'
    );
    for (const plugin of mergedPlugins) {
      const hookSummary = plugin.hooks.length > 0 ? plugin.hooks.join(', ') : 'none';
      const detailSummary = plugin.detail ? `${hookSummary} (${plugin.detail})` : hookSummary;
      lines.push(
        `| ${escapeMarkdownCell(plugin.name)} | \`${escapeMarkdownCell(plugin.id)}\` | \`${plugin.surface}\` | \`${escapeMarkdownCell(plugin.version)}\` | \`${plugin.status}\` | ${plugin.route_count} | ${escapeMarkdownCell(detailSummary)} |`
      );
    }
  }

  lines.push('', '### Recent Errors (Redacted)');
  if (recent_errors.length === 0) {
    lines.push('- No recent server errors recorded in this runtime process.');
  } else {
    lines.push('| Timestamp | Route | Status | Error Code |', '| --- | --- | ---: | --- |');
    for (const err of recent_errors) {
      lines.push(
        `| \`${escapeMarkdownCell(err.timestamp)}\` | \`${escapeMarkdownCell(err.route)}\` | ${err.status} | \`${escapeMarkdownCell(err.error_code)}\` |`
      );
    }
  }

  lines.push('', '</details>');
  return redactDiagnosticText(lines.join('\n'));
}

export function buildGitHubBugReportUrl(params: {
  readonly report: AdminDiagnosticsReport;
  readonly client: ClientEnvironmentSnapshot;
  readonly markdown: string;
  readonly maxUrlLength?: number;
}): GitHubBugReportLinkResult {
  const maxUrlLength = params.maxUrlLength ?? DEFAULT_MAX_GITHUB_ISSUE_URL_LENGTH;
  const { report, client, markdown } = params;

  const runtimeLabel =
    report.runtime.platform === 'node' && report.runtime.node_version
      ? `Node ${report.runtime.node_version}`
      : report.runtime.platform;

  const environmentSummary = redactDiagnosticText(
    `kinloom ${report.versions.server_version} (ui ${client.ui_version}), ${runtimeLabel}, ${client.os_summary}, ${client.browser_summary}`
  );

  const fullParams = new URLSearchParams({
    template: 'bug_report.yml',
    environment: environmentSummary,
    description: `Describe what happened here.\n\n${markdown}`,
  });
  const fullUrl = `${GITHUB_BUG_REPORT_BASE_URL}?${fullParams.toString()}`;

  if (fullUrl.length <= maxUrlLength) {
    return { url: fullUrl, diagnosticsIncludedInUrl: true };
  }

  const fallbackParams = new URLSearchParams({
    template: 'bug_report.yml',
    environment: environmentSummary,
    description:
      'Describe what happened here.\n\n<!-- Paste the copied Kinloom Diagnostics Markdown block below. -->\n',
  });
  return {
    url: `${GITHUB_BUG_REPORT_BASE_URL}?${fallbackParams.toString()}`,
    diagnosticsIncludedInUrl: false,
  };
}
