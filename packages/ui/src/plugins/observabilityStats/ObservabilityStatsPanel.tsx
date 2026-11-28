import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import {
  buildDailyTrendChartGeometry,
  formatCacheHitRatio,
  formatEntityKindLabel,
  formatVisitCount,
  OBSERVABILITY_STATS_SERVER_PLUGIN_ID,
  selectTopPagesByCategory,
  type TopPagesCategoryFilter,
  type UiAdminObservabilityStats,
  type UiObservabilityStatsWindow,
} from '../../lib/observabilityStatsModel.js';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import { useKinloomPlugins } from '../PluginContext.js';
import styles from './ObservabilityStats.module.css';
import { useObservabilityStatsContext } from './ObservabilityStatsContext.js';

type ToggleFeedback =
  | { readonly kind: 'idle' }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

const WINDOW_OPTIONS: readonly { readonly value: UiObservabilityStatsWindow; readonly label: string }[] = [
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: 'all', label: 'All Time' },
];

const CATEGORY_OPTIONS: readonly { readonly value: TopPagesCategoryFilter; readonly label: string }[] = [
  { value: 'all', label: 'All Pages' },
  { value: 'people', label: 'Ancestors' },
  { value: 'places', label: 'Places' },
  { value: 'narratives', label: 'Narratives' },
];

export const ObservabilityStatsPanel: React.FC = () => {
  const { client, defaultWindow, setShowPublicBadges } = useObservabilityStatsContext();
  const { subscribePluginSettings, notifyPluginSettingsUpdated } = useKinloomPlugins();
  const idPrefix = useId();

  const [activeWindow, setActiveWindow] = useState<UiObservabilityStatsWindow>(defaultWindow);
  const [categoryFilter, setCategoryFilter] = useState<TopPagesCategoryFilter>('all');
  const [stats, setStats] = useState<UiAdminObservabilityStats | null>(null);
  const [endpointDisabled, setEndpointDisabled] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<boolean>(false);
  const [toggleFeedback, setToggleFeedback] = useState<ToggleFeedback>({ kind: 'idle' });

  const loadStats = useCallback(
    async (win: UiObservabilityStatsWindow, signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await client.getAdminStats(win, { signal });
        if (signal?.aborted) {
          return;
        }
        if (result === null) {
          setStats(null);
          setEndpointDisabled(true);
        } else {
          setEndpointDisabled(false);
          setStats(result);
          setShowPublicBadges(result.public_badges_enabled);
        }
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [client, setShowPublicBadges]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadStats(activeWindow, controller.signal);
    return () => {
      controller.abort();
    };
  }, [activeWindow, loadStats]);

  useEffect(() => {
    return subscribePluginSettings(OBSERVABILITY_STATS_SERVER_PLUGIN_ID, (evt) => {
      if (evt.source === 'plugin-settings-section') {
        const nextFlag = evt.snapshot?.values.show_public_visit_badges;
        if (typeof nextFlag === 'boolean') {
          setStats((prev) => (prev ? { ...prev, public_badges_enabled: nextFlag } : prev));
        }
        void loadStats(activeWindow);
      }
    });
  }, [subscribePluginSettings, activeWindow, loadStats]);

  const handleTogglePublicBadges = async (nextChecked: boolean): Promise<void> => {
    if (toggling) {
      return;
    }
    setToggling(true);
    setToggleFeedback({ kind: 'idle' });
    try {
      const saved = await client.setPublicBadgesEnabled(nextChecked);
      setShowPublicBadges(saved);
      setStats((prev) => (prev ? { ...prev, public_badges_enabled: saved } : prev));
      notifyPluginSettingsUpdated({
        pluginId: OBSERVABILITY_STATS_SERVER_PLUGIN_ID,
        source: 'plugin-panel',
      });
      setToggleFeedback({
        kind: 'success',
        message: saved ? 'Public visit counts enabled.' : 'Public visit counts hidden.',
      });
    } catch (err) {
      setToggleFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setToggling(false);
    }
  };

  const chart = useMemo(() => buildDailyTrendChartGeometry(stats?.daily_trend ?? []), [stats?.daily_trend]);

  const visibleTopPages = useMemo(
    () => (stats ? selectTopPagesByCategory(stats, categoryFilter) : []),
    [stats, categoryFilter]
  );

  const headingId = `${idPrefix}-heading`;
  const chartTitleId = `${idPrefix}-chart-title`;
  const chartDescId = `${idPrefix}-chart-desc`;
  const tableHeadingId = `${idPrefix}-top-pages`;
  const switchId = `${idPrefix}-public-badges`;

  return (
    <section
      className={cx(layoutStyles, 'place-map-box')}
      aria-labelledby={headingId}
      data-testid="admin-observability-stats"
    >
      <div className={cx(styles, 'obs-header')}>
        <div className={cx(styles, 'obs-header-copy')}>
          <h2 id={headingId} className={cx(wikiPanelStyles, 'wiki-section-title')}>
            Archive Traffic &amp; Page Visit Stats
          </h2>
          <p className={cx(styles, 'obs-subtitle')}>
            Cookie-free, aggregate server-instance visit counts per route and UTC day. Zero cookies, zero IP
            storage, zero user fingerprinting, and strict exclusion of living relatives.
          </p>
        </div>
        <div className={cx(styles, 'obs-controls')}>
          <div className={cx(styles, 'obs-window-group')} role="group" aria-label="Traffic window">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={activeWindow === opt.value}
                className={cx(controlStyles, `pill-btn ${activeWindow === opt.value ? 'active' : ''}`)}
                onClick={() => {
                  setActiveWindow(opt.value);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
            disabled={loading}
            onClick={() => {
              void loadStats(activeWindow);
            }}
          >
            {loading ? 'Refreshing…' : 'Refresh Stats'}
          </button>
        </div>
      </div>

      {error && (
        <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
          <p>Could not load page visit stats: {error}</p>
        </div>
      )}

      {endpointDisabled && !error && (
        <p className={cx(controlStyles, 'empty-ring-note')} data-testid="obs-stats-disabled-note">
          Page visit stats are currently disabled on this server instance. Register{' '}
          <code>createPageVisitStatsPlugin()</code> on the server to enable aggregate tracking.
        </p>
      )}

      {loading && !stats && !endpointDisabled && !error && (
        <p className={cx(controlStyles, 'empty-ring-note')}>Loading page visit stats…</p>
      )}

      {stats && (
        <>
          <div className={cx(styles, 'obs-kpi-grid')}>
            <div className={cx(styles, 'obs-kpi-card')}>
              <span className={cx(styles, 'obs-kpi-label')}>Views (7d)</span>
              <span className={cx(styles, 'obs-kpi-value')} data-testid="obs-views-7d">
                {formatVisitCount(stats.totals.views_7d)}
              </span>
              <span className={cx(styles, 'obs-kpi-meta')}>Rolling 7 UTC days</span>
            </div>
            <div className={cx(styles, 'obs-kpi-card')}>
              <span className={cx(styles, 'obs-kpi-label')}>Views (30d)</span>
              <span className={cx(styles, 'obs-kpi-value')} data-testid="obs-views-30d">
                {formatVisitCount(stats.totals.views_30d)}
              </span>
              <span className={cx(styles, 'obs-kpi-meta')}>Rolling 30 UTC days</span>
            </div>
            <div className={cx(styles, 'obs-kpi-card')}>
              <span className={cx(styles, 'obs-kpi-label')}>All-Time Views</span>
              <span className={cx(styles, 'obs-kpi-value')} data-testid="obs-views-all">
                {formatVisitCount(stats.totals.views_all_time)}
              </span>
              <span className={cx(styles, 'obs-kpi-meta')}>
                Updated {formatArchivalTimestamp(stats.generated_at, true)}
              </span>
            </div>
            <div className={cx(styles, 'obs-kpi-card')}>
              <span className={cx(styles, 'obs-kpi-label')}>Bundle Revision</span>
              <span className={cx(styles, 'obs-kpi-value')} data-testid="obs-bundle-rev">
                r{stats.bundle_revision}
              </span>
              <span className={cx(styles, 'obs-kpi-meta')}>Mode: {stats.privacy_mode}</span>
            </div>
            <div className={cx(styles, 'obs-kpi-card')}>
              <span className={cx(styles, 'obs-kpi-label')}>Cache Hit Ratio</span>
              <span className={cx(styles, 'obs-kpi-value')} data-testid="obs-cache-ratio">
                {formatCacheHitRatio(stats.cache, stats.workers_observability_paired)}
              </span>
              <span className={cx(styles, 'obs-kpi-meta')}>
                {stats.workers_observability_paired
                  ? 'Paired with Workers Observability'
                  : 'Standalone server counter'}
              </span>
            </div>
          </div>

          <div className={cx(styles, 'obs-panel-block')}>
            <div className={cx(styles, 'obs-block-head')}>
              <h3 className={cx(styles, 'obs-block-title')}>Daily Visit Trend (UTC)</h3>
              <span className={cx(styles, 'obs-block-meta')}>
                Peak: {formatVisitCount(chart.peakViews)} / day · Total in chart:{' '}
                {formatVisitCount(chart.totalViews)}
              </span>
            </div>
            <div className={cx(styles, 'obs-chart-card')}>
              <svg
                className={cx(styles, 'obs-chart-svg')}
                viewBox={`0 0 ${chart.viewBoxWidth} ${chart.viewBoxHeight}`}
                role="img"
                aria-labelledby={`${chartTitleId} ${chartDescId}`}
                data-testid="obs-daily-trend-chart"
              >
                <title id={chartTitleId}>Daily archive visit trend</title>
                <desc id={chartDescId}>
                  Bar chart of aggregate page visits across {chart.bars.length} UTC days, totaling{' '}
                  {chart.totalViews} views with a daily peak of {chart.peakViews}.
                </desc>
                <line
                  x1={12}
                  y1={chart.chartTop}
                  x2={chart.viewBoxWidth - 12}
                  y2={chart.chartTop}
                  className={cx(styles, 'obs-chart-gridline')}
                />
                <line
                  x1={12}
                  y1={Math.round((chart.chartTop + chart.chartBottom) / 2)}
                  x2={chart.viewBoxWidth - 12}
                  y2={Math.round((chart.chartTop + chart.chartBottom) / 2)}
                  className={cx(styles, 'obs-chart-gridline')}
                />
                <line
                  x1={12}
                  y1={chart.chartBottom}
                  x2={chart.viewBoxWidth - 12}
                  y2={chart.chartBottom}
                  className={cx(styles, 'obs-chart-baseline')}
                />
                {chart.bars.map((bar) => (
                  <g key={bar.dayUtc}>
                    <rect
                      x={bar.x}
                      y={bar.y}
                      width={bar.width}
                      height={bar.height}
                      rx={2}
                      className={cx(styles, bar.views > 0 ? 'obs-chart-bar' : 'obs-chart-bar-zero')}
                    >
                      <title>
                        {bar.dayUtc}: {formatVisitCount(bar.views)} views
                      </title>
                    </rect>
                    {bar.showAxisLabel && (
                      <text
                        x={bar.x + bar.width / 2}
                        y={chart.chartBottom + 18}
                        textAnchor="middle"
                        className={cx(styles, 'obs-chart-axis-label')}
                      >
                        {bar.shortLabel}
                      </text>
                    )}
                  </g>
                ))}
              </svg>
            </div>
          </div>

          <div className={cx(styles, 'obs-panel-block')}>
            <div className={cx(styles, 'obs-block-head')}>
              <h3 id={tableHeadingId} className={cx(styles, 'obs-block-title')}>
                Top Visited Pages
              </h3>
              <div className={cx(styles, 'obs-window-group')} role="group" aria-label="Filter top pages">
                {CATEGORY_OPTIONS.map((cat) => (
                  <button
                    key={cat.value}
                    type="button"
                    aria-pressed={categoryFilter === cat.value}
                    className={cx(controlStyles, `pill-btn ${categoryFilter === cat.value ? 'active' : ''}`)}
                    onClick={() => {
                      setCategoryFilter(cat.value);
                    }}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {visibleTopPages.length === 0 ? (
              <p className={cx(controlStyles, 'empty-ring-note')}>
                No recorded visits for this category in the selected window yet.
              </p>
            ) : (
              <div
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable responsive table region requires keyboard scroll access per modern-web-guidance.
                tabIndex={0}
                role="region"
                aria-labelledby={tableHeadingId}
                className={cx(styles, 'obs-table-wrapper')}
              >
                <table className={cx(styles, 'obs-table')} data-testid="obs-top-pages-table">
                  <thead>
                    <tr>
                      <th scope="col">Page</th>
                      <th scope="col">Type</th>
                      <th scope="col">Route</th>
                      <th scope="col" className={cx(styles, 'obs-table-num')}>
                        Views
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTopPages.map((row) => (
                      <tr key={row.route_key}>
                        <th scope="row">{row.title}</th>
                        <td data-label="Type">
                          <span className={cx(styles, 'obs-kind-pill')}>
                            {formatEntityKindLabel(row.entity_kind)}
                          </span>
                        </td>
                        <td data-label="Route" className={cx(styles, 'obs-mono')}>
                          {row.route_key}
                        </td>
                        <td data-label="Views" className={cx(styles, 'obs-table-num')}>
                          {formatVisitCount(row.views)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={cx(styles, 'obs-pref-box')}>
            <div className={cx(styles, 'obs-switch-row')}>
              <input
                id={switchId}
                type="checkbox"
                role="switch"
                aria-checked={stats.public_badges_enabled}
                checked={stats.public_badges_enabled}
                disabled={toggling}
                className={cx(styles, 'obs-switch-input')}
                data-testid="obs-public-badges-switch"
                onChange={(e) => {
                  void handleTogglePublicBadges(e.target.checked);
                }}
              />
              <label htmlFor={switchId} className={cx(styles, 'obs-switch-label')}>
                Show subtle visit counts on deceased person, place, and narrative pages
              </label>
              <span
                role="status"
                aria-live="polite"
                className={cx(
                  styles,
                  toggleFeedback.kind === 'success'
                    ? 'obs-status-msg is-success'
                    : toggleFeedback.kind === 'error'
                      ? 'obs-status-msg is-error'
                      : 'obs-status-msg'
                )}
              >
                {toggleFeedback.kind === 'idle' ? '' : toggleFeedback.message}
              </span>
            </div>
            <p className={cx(styles, 'obs-pref-help')}>
              Living relatives are strictly excluded from visit storage, top pages, and public badges
              regardless of this toggle.
            </p>
          </div>
        </>
      )}
    </section>
  );
};
