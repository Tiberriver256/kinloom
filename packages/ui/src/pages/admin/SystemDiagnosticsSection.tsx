import type { AdminDiagnosticsReport } from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import {
  buildGitHubBugReportUrl,
  type ClientEnvironmentSnapshot,
  formatBytesCompact,
  formatDiagnosticsMarkdown,
  mergePluginDiagnostics,
  parseClientUserAgent,
  type UiPluginDiagnosticInput,
} from '../../lib/adminDiagnostics.js';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import { useKinloomPlugins } from '../../plugins/PluginContext.js';
import type { KinloomUiPlugin } from '../../plugins/types.js';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import { KINLOOM_UI_VERSION } from '../../version.js';
import diagStyles from './SystemDiagnosticsSection.module.css';

export interface SystemDiagnosticsSectionProps {
  readonly report: AdminDiagnosticsReport | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly supported: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly maxIssueUrlLength?: number;
}

type CopyFeedbackState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

function collectClientEnvironment(): ClientEnvironmentSnapshot {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const { browser, os } = parseClientUserAgent(userAgent);
  const width = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0;
  const height =
    typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
  const dpr =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? Math.round(window.devicePixelRatio * 100) / 100
      : 1;

  return {
    ui_version: KINLOOM_UI_VERSION,
    browser_summary: browser,
    os_summary: os,
    viewport: `${width}x${height}`,
    device_pixel_ratio: dpr,
    origin_mode: 'omitted',
  };
}

function summarizeUiPluginHooks(plugin: KinloomUiPlugin): string[] {
  const hooks: string[] = [];
  if (plugin.provider) {
    hooks.push('provider');
  }
  if (plugin.slots) {
    for (const [slotName, renderer] of Object.entries(plugin.slots)) {
      if (renderer) {
        hooks.push(`slot:${slotName}`);
      }
    }
  }
  if (plugin.mediaRenderers && plugin.mediaRenderers.length > 0) {
    hooks.push('mediaRenderers');
  }
  if (plugin.entityEditForms && Object.keys(plugin.entityEditForms).length > 0) {
    hooks.push('entityEditForms');
  }
  if (plugin.entityCreateForms && Object.keys(plugin.entityCreateForms).length > 0) {
    hooks.push('entityCreateForms');
  }
  return hooks;
}

export const SystemDiagnosticsSection: React.FC<SystemDiagnosticsSectionProps> = ({
  report,
  loading,
  error,
  supported,
  onRefresh,
  maxIssueUrlLength,
}) => {
  const { plugins: uiPlugins } = useKinloomPlugins();
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedbackState>({ kind: 'idle' });
  const lastAnnouncementRef = useRef<string>('');
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  const clientEnv = useMemo<ClientEnvironmentSnapshot>(() => collectClientEnvironment(), []);

  const uiPluginInputs = useMemo<readonly UiPluginDiagnosticInput[]>(
    () =>
      uiPlugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        status: plugin.status,
        routeCount: plugin.routes?.length ?? 0,
        hooks: summarizeUiPluginHooks(plugin),
      })),
    [uiPlugins]
  );

  const mergedPlugins = useMemo(
    () => mergePluginDiagnostics(report?.plugins ?? [], uiPluginInputs),
    [report, uiPluginInputs]
  );

  const keyedRecentErrors = useMemo(() => {
    const seen = new Map<string, number>();
    return (report?.recent_errors ?? []).map((item) => {
      const baseKey = `${item.timestamp}:${item.route}:${item.status}:${item.error_code}`;
      const count = (seen.get(baseKey) ?? 0) + 1;
      seen.set(baseKey, count);
      return { key: `${baseKey}#${count}`, item };
    });
  }, [report]);

  const markdownBundle = useMemo(
    () =>
      report
        ? formatDiagnosticsMarkdown({
            report,
            client: clientEnv,
            mergedPlugins,
          })
        : '',
    [report, clientEnv, mergedPlugins]
  );

  const bugReportLink = useMemo(
    () =>
      report
        ? buildGitHubBugReportUrl({
            report,
            client: clientEnv,
            markdown: markdownBundle,
            maxUrlLength: maxIssueUrlLength,
          })
        : null,
    [report, clientEnv, markdownBundle, maxIssueUrlLength]
  );

  const announceCopy = (ok: boolean): void => {
    if (!mountedRef.current) {
      return;
    }
    if (resetTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(resetTimerRef.current);
    }
    const baseMessage = ok ? 'Copied' : 'Copy failed';
    // Append a no-break space on repeated identical announcements so VoiceOver announces repeat clicks.
    const message = lastAnnouncementRef.current === baseMessage ? `${baseMessage}\u00A0` : baseMessage;
    lastAnnouncementRef.current = message;
    setCopyFeedback(ok ? { kind: 'success', message } : { kind: 'error', message });
    if (typeof window !== 'undefined') {
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        if (mountedRef.current) {
          setCopyFeedback({ kind: 'idle' });
        }
      }, 2500);
    }
  };

  const handleCopyMarkdown = async (): Promise<void> => {
    if (!markdownBundle) {
      return;
    }
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      announceCopy(false);
      return;
    }
    try {
      await clipboard.writeText(markdownBundle);
      announceCopy(true);
    } catch {
      announceCopy(false);
    }
  };

  return (
    <section
      className={cx(layoutStyles, 'place-map-box')}
      aria-labelledby="admin-system-diagnostics-heading"
      data-testid="admin-system-diagnostics"
    >
      <div className={cx(diagStyles, 'diag-header')}>
        <div className={cx(diagStyles, 'diag-header-copy')}>
          <h2 id="admin-system-diagnostics-heading" className={cx(wikiPanelStyles, 'wiki-section-title')}>
            Core Application Settings &amp; Diagnostics
          </h2>
          <p className={cx(diagStyles, 'diag-subtitle')}>
            Strictly redacted runtime versions, storage health, configuration flags, and installed plugins for
            troubleshooting and GitHub bug reports. Zero secrets, tokens, emails, or living-person records are
            included.
          </p>
        </div>
        {supported && (
          <div className={cx(diagStyles, 'diag-actions')}>
            <span className={cx(diagStyles, 'diag-copy-wrap')}>
              <button
                type="button"
                className={cx(wikiChromeStyles, 'wiki-btn-primary wiki-btn-sm')}
                disabled={!report}
                data-copied={copyFeedback.kind === 'success' ? '' : undefined}
                data-failed={copyFeedback.kind === 'error' ? '' : undefined}
                onClick={() => {
                  void handleCopyMarkdown();
                }}
              >
                Copy Diagnostics for GitHub Issue
              </button>
              <span
                role="status"
                className={cx(
                  diagStyles,
                  copyFeedback.kind === 'success'
                    ? 'diag-copy-status is-visible is-success'
                    : copyFeedback.kind === 'error'
                      ? 'diag-copy-status is-visible is-error'
                      : 'diag-copy-status'
                )}
              >
                {copyFeedback.kind === 'idle' ? '' : copyFeedback.message}
              </span>
            </span>
            {bugReportLink && (
              <a
                href={bugReportLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
              >
                Open GitHub Bug Report
              </a>
            )}
            <button
              type="button"
              className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
              disabled={loading}
              onClick={() => {
                void onRefresh();
              }}
            >
              {loading ? 'Refreshing…' : 'Refresh Diagnostics'}
            </button>
          </div>
        )}
      </div>

      {!supported && (
        <p className={cx(controlStyles, 'empty-ring-note')}>
          System diagnostics endpoint is not provided by the active admin data source.
        </p>
      )}

      {error && (
        <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
          <p>Could not load system diagnostics: {error}</p>
        </div>
      )}

      {supported && loading && !report && (
        <p className={cx(controlStyles, 'empty-ring-note')}>Loading system diagnostics…</p>
      )}

      {bugReportLink && !bugReportLink.diagnosticsIncludedInUrl && (
        <div className={cx(wikiPanelStyles, 'wiki-status-banner is-info')} role="note">
          <p>
            The diagnostics bundle is too long to pre-fill in the GitHub URL. Click{' '}
            <strong>Copy Diagnostics for GitHub Issue</strong> first, then paste it into the GitHub issue
            form.
          </p>
        </div>
      )}

      {report && (
        <>
          <div className={cx(diagStyles, 'diag-grid')}>
            <div className={cx(diagStyles, 'diag-card')}>
              <h3 className={cx(diagStyles, 'diag-card-title')}>Versions &amp; Build Provenance</h3>
              <dl className={cx(diagStyles, 'diag-dl')}>
                <dt>UI version</dt>
                <dd>{clientEnv.ui_version}</dd>
                <dt>Server version</dt>
                <dd>{report.versions.server_version}</dd>
                <dt>Core version</dt>
                <dd>{report.versions.core_version}</dd>
                <dt>Worker version</dt>
                <dd>{report.versions.worker_version ?? 'n/a'}</dd>
                <dt>Build commit</dt>
                <dd>{report.versions.build_commit_sha ?? 'n/a'}</dd>
                <dt>Build timestamp</dt>
                <dd>{report.versions.build_timestamp ?? 'n/a'}</dd>
                <dt>Schema migration</dt>
                <dd>{report.versions.schema_migration_level ?? 'n/a'}</dd>
              </dl>
            </div>

            <div className={cx(diagStyles, 'diag-card')}>
              <h3 className={cx(diagStyles, 'diag-card-title')}>Runtime &amp; Storage Backends</h3>
              <dl className={cx(diagStyles, 'diag-dl')}>
                <dt>Platform</dt>
                <dd>{report.runtime.platform}</dd>
                <dt>Node version</dt>
                <dd>{report.runtime.node_version ?? 'n/a'}</dd>
                <dt>Compat date</dt>
                <dd>{report.runtime.workers_compatibility_date ?? 'n/a'}</dd>
                <dt>Repository</dt>
                <dd>{report.runtime.adapters.repository}</dd>
                <dt>Bundle cache</dt>
                <dd>{report.runtime.adapters.bundle_cache}</dd>
                <dt>Media store</dt>
                <dd>{report.runtime.adapters.media_store}</dd>
                <dt>Email sender</dt>
                <dd>{report.runtime.adapters.email_sender}</dd>
                <dt>OAuth provider</dt>
                <dd>
                  {report.runtime.adapters.auth_provider_configured
                    ? (report.runtime.adapters.auth_provider_id ?? 'configured')
                    : 'not configured'}
                </dd>
                <dt>Pronunciation TTS</dt>
                <dd>{report.runtime.adapters.pronunciation_generator}</dd>
                <dt>Lexicon store</dt>
                <dd>{report.runtime.adapters.pronunciation_lexicon_store}</dd>
              </dl>
            </div>

            <div className={cx(diagStyles, 'diag-card')}>
              <h3 className={cx(diagStyles, 'diag-card-title')}>Redacted Configuration Flags</h3>
              <dl className={cx(diagStyles, 'diag-dl')}>
                <dt>Archive mode</dt>
                <dd>{report.config.mode}</dd>
                <dt>Read-only demo</dt>
                <dd>{report.config.read_only_demo ? 'enabled' : 'disabled'}</dd>
                <dt>Google OAuth</dt>
                <dd>{report.config.auth_methods.google_oauth ? 'enabled' : 'disabled'}</dd>
                <dt>Observability</dt>
                <dd>{report.config.observability.enabled ? 'enabled' : 'disabled'}</dd>
                <dt>Server-Timing</dt>
                <dd>{report.config.observability.server_timing ? 'enabled' : 'disabled'}</dd>
                <dt>Security telemetry</dt>
                <dd>{report.config.observability.security_telemetry ? 'enabled' : 'disabled'}</dd>
                <dt>Web Analytics</dt>
                <dd>{report.config.observability.web_analytics ? 'enabled' : 'disabled'}</dd>
                <dt>Living cutoff</dt>
                <dd>{report.config.privacy.living_cutoff_years} years</dd>
                <dt>Max upload</dt>
                <dd>{formatBytesCompact(report.config.wiki.max_upload_bytes)}</dd>
              </dl>
            </div>

            <div className={cx(diagStyles, 'diag-card')}>
              <h3 className={cx(diagStyles, 'diag-card-title')}>Archive Counts (Aggregate Only)</h3>
              <dl className={cx(diagStyles, 'diag-dl')}>
                <dt>Head revision</dt>
                <dd>r{report.archive.head_revision_id}</dd>
                <dt>Bundle cache</dt>
                <dd>{report.archive.bundle_cache_status}</dd>
                <dt>People (deceased)</dt>
                <dd>{report.archive.counts.people_deceased}</dd>
                <dt>People (living)</dt>
                <dd>{report.archive.counts.people_living}</dd>
                <dt>Events</dt>
                <dd>{report.archive.counts.events}</dd>
                <dt>Places</dt>
                <dd>{report.archive.counts.places}</dd>
                <dt>Sources</dt>
                <dd>{report.archive.counts.sources}</dd>
                <dt>Media</dt>
                <dd>{report.archive.counts.media}</dd>
                <dt>Narratives</dt>
                <dd>{report.archive.counts.narratives}</dd>
              </dl>
            </div>
          </div>

          <div className={cx(diagStyles, 'diag-subsection')}>
            <h3 id="diag-health-heading" className={cx(diagStyles, 'diag-subsection-title')}>
              Live Health Checks
            </h3>
            <div
              role="region"
              aria-labelledby="diag-health-heading"
              className={cx(diagStyles, 'diag-table-wrapper')}
            >
              <table className={cx(diagStyles, 'diag-table')}>
                <thead>
                  <tr>
                    <th scope="col">Check</th>
                    <th scope="col">Status</th>
                    <th scope="col">Latency</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {report.health_checks.map((check) => (
                    <tr key={check.name}>
                      <th scope="row" className={cx(diagStyles, 'diag-mono')}>
                        {check.name}
                      </th>
                      <td data-label="Status">
                        <span className={cx(diagStyles, `diag-status-pill is-${check.status}`)}>
                          {check.status}
                        </span>
                      </td>
                      <td data-label="Latency" className={cx(diagStyles, 'diag-mono')}>
                        {check.latency_ms} ms
                      </td>
                      <td data-label="Detail">{check.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className={cx(diagStyles, 'diag-subsection')}>
            <h3 id="diag-plugins-heading" className={cx(diagStyles, 'diag-subsection-title')}>
              Installed Plugins ({mergedPlugins.length})
            </h3>
            {mergedPlugins.length === 0 ? (
              <p className={cx(controlStyles, 'empty-ring-note')}>
                No server or UI plugins are currently registered.
              </p>
            ) : (
              <div
                role="region"
                aria-labelledby="diag-plugins-heading"
                className={cx(diagStyles, 'diag-table-wrapper')}
              >
                <table className={cx(diagStyles, 'diag-table')}>
                  <thead>
                    <tr>
                      <th scope="col">Plugin</th>
                      <th scope="col">ID</th>
                      <th scope="col">Surface</th>
                      <th scope="col">Version</th>
                      <th scope="col">Status</th>
                      <th scope="col">Routes</th>
                      <th scope="col">Hooks &amp; Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mergedPlugins.map((plugin) => (
                      <tr key={`${plugin.surface}:${plugin.id}`}>
                        <th scope="row">{plugin.name}</th>
                        <td data-label="ID" className={cx(diagStyles, 'diag-mono')}>
                          {plugin.id}
                        </td>
                        <td data-label="Surface" className={cx(diagStyles, 'diag-mono')}>
                          {plugin.surface}
                        </td>
                        <td data-label="Version" className={cx(diagStyles, 'diag-mono')}>
                          {plugin.version}
                        </td>
                        <td data-label="Status">
                          <span className={cx(diagStyles, `diag-status-pill is-${plugin.status}`)}>
                            {plugin.status}
                          </span>
                        </td>
                        <td data-label="Routes" className={cx(diagStyles, 'diag-mono')}>
                          {plugin.route_count}
                        </td>
                        <td data-label="Hooks & Detail" className={cx(diagStyles, 'diag-mono')}>
                          {plugin.hooks.length > 0 ? plugin.hooks.join(', ') : 'none'}
                          {plugin.detail ? ` · ${plugin.detail}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={cx(diagStyles, 'diag-subsection')}>
            <h3 id="diag-errors-heading" className={cx(diagStyles, 'diag-subsection-title')}>
              Recent Errors ({report.recent_errors.length})
            </h3>
            {report.recent_errors.length === 0 ? (
              <p className={cx(controlStyles, 'empty-ring-note')}>
                No server errors recorded in this runtime process.
              </p>
            ) : (
              <div
                role="region"
                aria-labelledby="diag-errors-heading"
                className={cx(diagStyles, 'diag-table-wrapper')}
              >
                <table className={cx(diagStyles, 'diag-table')}>
                  <thead>
                    <tr>
                      <th scope="col">Timestamp</th>
                      <th scope="col">Route Template</th>
                      <th scope="col">HTTP Status</th>
                      <th scope="col">Error Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keyedRecentErrors.map(({ key, item }) => (
                      <tr key={key}>
                        <th scope="row" className={cx(diagStyles, 'diag-mono')}>
                          <time dateTime={item.timestamp} title={item.timestamp}>
                            {formatArchivalTimestamp(item.timestamp, true)}
                          </time>
                        </th>
                        <td data-label="Route Template" className={cx(diagStyles, 'diag-mono')}>
                          {item.route}
                        </td>
                        <td data-label="HTTP Status" className={cx(diagStyles, 'diag-mono')}>
                          {item.status}
                        </td>
                        <td data-label="Error Code" className={cx(diagStyles, 'diag-mono')}>
                          {item.error_code}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <details className={cx(diagStyles, 'diag-preview')}>
            <summary>Preview Redacted GitHub Diagnostics Markdown</summary>
            <pre>
              <code>{markdownBundle}</code>
            </pre>
          </details>
        </>
      )}
    </section>
  );
};
