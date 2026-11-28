import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import {
  buildUiDonationPlatformUrl,
  computeUiOpenFinanceTotals,
  formatCentsToDecimalInput,
  formatCostCadenceLabel,
  formatCostCategoryLabel,
  formatUiCurrencyCents,
  normalizeUiOpenFinanceConfig,
  OPEN_FINANCE_SERVER_PLUGIN_ID,
  parseDecimalMoneyToCents,
  UI_DONATION_PLATFORM_IDS,
  UI_DONATION_PLATFORM_REGISTRY,
  UI_OPEN_FINANCE_COST_CADENCES,
  UI_OPEN_FINANCE_COST_CATEGORIES,
  UI_OPEN_FINANCE_CURRENCIES,
  type UiDonationPlatformId,
  type UiOpenFinanceConfig,
  type UiOpenFinanceConfigInput,
  type UiOpenFinanceCostCadence,
  type UiOpenFinanceCostCategory,
  type UiOpenFinanceCostItem,
  type UiOpenFinanceCurrency,
} from '../../lib/openFinanceModel.js';
import layoutStyles from '../../styles/Layout.module.css';
import { useKinloomPlugins } from '../PluginContext.js';
import styles from './OpenFinance.module.css';
import { useOpenFinanceContext } from './OpenFinanceContext.js';

interface PlatformDraftRow {
  readonly platform: UiDonationPlatformId;
  readonly urlOrHandle: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
}

interface CostItemDraftRow {
  readonly id: string;
  readonly label: string;
  readonly category: UiOpenFinanceCostCategory;
  readonly cadence: UiOpenFinanceCostCadence;
  readonly amountText: string;
  readonly vendor: string;
  readonly notes: string;
  readonly active: boolean;
}

interface OpenFinanceDraftState {
  readonly pageTitle: string;
  readonly navLabel: string;
  readonly supporterMessage: string;
  readonly currency: UiOpenFinanceCurrency;
  readonly showSupportPage: boolean;
  readonly showInNav: boolean;
  readonly showInFooter: boolean;
  readonly primaryPlatform: UiDonationPlatformId | '';
  readonly platforms: readonly PlatformDraftRow[];
  readonly costItems: readonly CostItemDraftRow[];
  readonly goalEnabled: boolean;
  readonly goalPeriod: 'monthly' | 'annual';
  readonly goalTargetText: string;
  readonly goalReceivedText: string;
  readonly goalLabel: string;
  readonly goalAsOfDate: string;
}

type SaveFeedback =
  | { readonly kind: 'idle' }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

function configToDraft(config: UiOpenFinanceConfig): OpenFinanceDraftState {
  return {
    pageTitle: config.page_title,
    navLabel: config.nav_label,
    supporterMessage: config.supporter_message,
    currency: config.currency,
    showSupportPage: config.visibility.show_support_page,
    showInNav: config.visibility.show_in_nav,
    showInFooter: config.visibility.show_in_footer,
    primaryPlatform: config.primary_platform ?? '',
    platforms: config.platforms.map((p) => ({
      platform: p.platform,
      urlOrHandle: p.url,
      label: p.label,
      description: p.description ?? '',
      enabled: p.enabled,
    })),
    costItems: config.cost_items.map((item) => ({
      id: item.id,
      label: item.label,
      category: item.category,
      cadence: item.cadence,
      amountText: formatCentsToDecimalInput(item.amount_cents),
      vendor: item.vendor ?? '',
      notes: item.notes ?? '',
      active: item.active !== false,
    })),
    goalEnabled: config.funding_goal?.enabled ?? false,
    goalPeriod: config.funding_goal?.period ?? 'annual',
    goalTargetText: config.funding_goal
      ? formatCentsToDecimalInput(config.funding_goal.target_cents)
      : '0.00',
    goalReceivedText: config.funding_goal
      ? formatCentsToDecimalInput(config.funding_goal.received_cents)
      : '0.00',
    goalLabel: config.funding_goal?.label ?? '',
    goalAsOfDate: config.funding_goal?.as_of_date ?? '',
  };
}

function buildConfigInputFromDraft(
  draft: OpenFinanceDraftState
):
  | { readonly ok: true; readonly payload: UiOpenFinanceConfigInput }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> } {
  const errors: Record<string, string> = {};

  const pageTitle = draft.pageTitle.trim();
  if (!pageTitle) {
    errors['pageTitle'] = 'Support page title is required.';
  }
  const navLabel = draft.navLabel.trim();
  if (!navLabel) {
    errors['navLabel'] = 'Navigation label is required.';
  }

  const platformsPayload: {
    platform: UiDonationPlatformId;
    url: string;
    label: string;
    description?: string;
    enabled: boolean;
  }[] = [];

  for (let i = 0; i < draft.platforms.length; i += 1) {
    const row = draft.platforms[i];
    if (!row) {
      continue;
    }
    const spec = UI_DONATION_PLATFORM_REGISTRY[row.platform];
    const urlResult = buildUiDonationPlatformUrl(row.platform, row.urlOrHandle);
    if (!urlResult.ok) {
      errors[`platform.${row.platform}`] = urlResult.error;
      continue;
    }
    platformsPayload.push({
      platform: row.platform,
      url: urlResult.url,
      label: row.label.trim() || spec.defaultCtaLabel,
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
      enabled: row.enabled,
    });
  }

  const costItemsPayload: UiOpenFinanceCostItem[] = [];
  for (let i = 0; i < draft.costItems.length; i += 1) {
    const row = draft.costItems[i];
    if (!row) {
      continue;
    }
    const label = row.label.trim();
    if (!label) {
      errors[`cost.${row.id}.label`] = 'Cost item label is required.';
    }
    const cents = parseDecimalMoneyToCents(row.amountText);
    if (cents === null) {
      errors[`cost.${row.id}.amount`] = 'Enter a valid non-negative amount (for example, 12.50).';
      continue;
    }
    costItemsPayload.push({
      id: row.id,
      label: label || row.id,
      category: row.category,
      cadence: row.cadence,
      amount_cents: cents,
      ...(row.vendor.trim() ? { vendor: row.vendor.trim() } : {}),
      ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
      active: row.active,
    });
  }

  let fundingGoalPayload: UiOpenFinanceConfigInput['funding_goal'] = null;
  if (draft.goalEnabled) {
    const targetCents = parseDecimalMoneyToCents(draft.goalTargetText);
    const receivedCents = parseDecimalMoneyToCents(draft.goalReceivedText);
    if (targetCents === null) {
      errors['goalTarget'] = 'Target amount must be a valid non-negative amount.';
    }
    if (receivedCents === null) {
      errors['goalReceived'] = 'Received amount must be a valid non-negative amount.';
    }
    if (draft.goalAsOfDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(draft.goalAsOfDate.trim())) {
      errors['goalAsOfDate'] = 'As-of date must use YYYY-MM-DD format.';
    }
    if (targetCents !== null && receivedCents !== null) {
      fundingGoalPayload = {
        enabled: true,
        period: draft.goalPeriod,
        target_cents: targetCents,
        received_cents: receivedCents,
        ...(draft.goalLabel.trim() ? { label: draft.goalLabel.trim() } : {}),
        ...(draft.goalAsOfDate.trim() ? { as_of_date: draft.goalAsOfDate.trim() } : {}),
      };
    }
  }

  const enabledPlatformIds = new Set(platformsPayload.filter((p) => p.enabled).map((p) => p.platform));
  const resolvedPrimary =
    draft.primaryPlatform && enabledPlatformIds.has(draft.primaryPlatform)
      ? draft.primaryPlatform
      : (platformsPayload.find((p) => p.enabled)?.platform ?? null);

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    payload: {
      page_title: pageTitle,
      nav_label: navLabel,
      supporter_message: draft.supporterMessage.trim(),
      currency: draft.currency,
      visibility: {
        show_support_page: draft.showSupportPage,
        show_in_nav: draft.showInNav,
        show_in_footer: draft.showInFooter,
      },
      primary_platform: resolvedPrimary,
      platforms: platformsPayload,
      cost_items: costItemsPayload,
      funding_goal: fundingGoalPayload,
    },
  };
}

export const OpenFinanceAdminPanel: React.FC = () => {
  const { client, initialConfig, applyAdminUpdate } = useOpenFinanceContext();
  const { subscribePluginSettings, notifyPluginSettingsUpdated } = useKinloomPlugins();
  const idPrefix = useId();

  const [draft, setDraft] = useState<OpenFinanceDraftState>(() =>
    configToDraft(initialConfig ?? normalizeUiOpenFinanceConfig({}))
  );
  const [loading, setLoading] = useState<boolean>(Boolean(client));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [endpointDisabled, setEndpointDisabled] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [feedback, setFeedback] = useState<SaveFeedback>({ kind: 'idle' });
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [platformToAdd, setPlatformToAdd] = useState<UiDonationPlatformId>('github_sponsors');

  const loadConfig = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!client) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const result = await client.getAdminConfig({ signal });
        if (signal?.aborted) {
          return;
        }
        if (result === null) {
          setEndpointDisabled(true);
        } else {
          setEndpointDisabled(false);
          setDraft(configToDraft(result.config));
          setUpdatedAt(result.updated_at);
          setUpdatedBy(result.updated_by);
          applyAdminUpdate(result);
        }
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [client, applyAdminUpdate]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadConfig]);

  useEffect(() => {
    return subscribePluginSettings(OPEN_FINANCE_SERVER_PLUGIN_ID, (evt) => {
      if (evt.source === 'plugin-settings-section') {
        void loadConfig();
      }
    });
  }, [subscribePluginSettings, loadConfig]);

  const availablePlatformsToAdd = useMemo(() => {
    const configured = new Set(draft.platforms.map((p) => p.platform));
    return UI_DONATION_PLATFORM_IDS.filter((id) => !configured.has(id));
  }, [draft.platforms]);

  useEffect(() => {
    const firstAvailable = availablePlatformsToAdd[0];
    if (firstAvailable && !availablePlatformsToAdd.includes(platformToAdd)) {
      setPlatformToAdd(firstAvailable);
    }
  }, [availablePlatformsToAdd, platformToAdd]);

  const previewTotals = useMemo(() => {
    const items: UiOpenFinanceCostItem[] = draft.costItems.map((row) => ({
      id: row.id,
      label: row.label,
      category: row.category,
      cadence: row.cadence,
      amount_cents: parseDecimalMoneyToCents(row.amountText) ?? 0,
      active: row.active,
    }));
    return computeUiOpenFinanceTotals(items);
  }, [draft.costItems]);

  const handleAddPlatform = (): void => {
    if (!availablePlatformsToAdd.includes(platformToAdd)) {
      return;
    }
    const spec = UI_DONATION_PLATFORM_REGISTRY[platformToAdd];
    setDraft((prev) => ({
      ...prev,
      platforms: [
        ...prev.platforms,
        {
          platform: platformToAdd,
          urlOrHandle: '',
          label: spec.defaultCtaLabel,
          description: '',
          enabled: true,
        },
      ],
      primaryPlatform: prev.primaryPlatform || platformToAdd,
    }));
  };

  const handleMovePlatform = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= draft.platforms.length) {
      return;
    }
    setDraft((prev) => {
      const next = [...prev.platforms];
      const current = next[index];
      const swap = next[target];
      if (!current || !swap) {
        return prev;
      }
      next[index] = swap;
      next[target] = current;
      return { ...prev, platforms: next };
    });
  };

  const handleRemovePlatform = (platform: UiDonationPlatformId): void => {
    setDraft((prev) => {
      const remaining = prev.platforms.filter((p) => p.platform !== platform);
      const nextPrimary =
        prev.primaryPlatform === platform
          ? (remaining.find((p) => p.enabled)?.platform ?? '')
          : prev.primaryPlatform;
      return { ...prev, platforms: remaining, primaryPlatform: nextPrimary };
    });
  };

  const handleAddCostItem = (): void => {
    const existingIds = new Set(draft.costItems.map((i) => i.id));
    let n = draft.costItems.length + 1;
    let candidate = `cost-${n}`;
    while (existingIds.has(candidate)) {
      n += 1;
      candidate = `cost-${n}`;
    }
    setDraft((prev) => ({
      ...prev,
      costItems: [
        ...prev.costItems,
        {
          id: candidate,
          label: '',
          category: 'hosting',
          cadence: 'monthly',
          amountText: '0.00',
          vendor: '',
          notes: '',
          active: true,
        },
      ],
    }));
  };

  const handleRemoveCostItem = (id: string): void => {
    setDraft((prev) => ({
      ...prev,
      costItems: prev.costItems.filter((item) => item.id !== id),
    }));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (saving || !client) {
      return;
    }
    setFeedback({ kind: 'idle' });
    const built = buildConfigInputFromDraft(draft);
    if (!built.ok) {
      setFieldErrors(built.errors);
      setFeedback({
        kind: 'error',
        message: Object.values(built.errors)[0] ?? 'Please fix the highlighted validation errors.',
      });
      return;
    }

    setFieldErrors({});
    setSaving(true);
    try {
      const saved = await client.saveAdminConfig(built.payload);
      setDraft(configToDraft(saved.config));
      setUpdatedAt(saved.updated_at);
      setUpdatedBy(saved.updated_by);
      applyAdminUpdate(saved);
      notifyPluginSettingsUpdated({
        pluginId: OPEN_FINANCE_SERVER_PLUGIN_ID,
        source: 'plugin-panel',
      });
      setFeedback({ kind: 'success', message: 'Open Finance settings saved.' });
    } catch (err) {
      setFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const headingId = `${idPrefix}-of-admin-heading`;

  return (
    <section
      className={cx(layoutStyles, 'place-map-box')}
      aria-labelledby={headingId}
      data-testid="admin-open-finance-panel"
    >
      <div className={cx(styles, 'of-admin-header')}>
        <div>
          <h2 id={headingId} className={cx(wikiPanelStyles, 'wiki-section-title')}>
            Open Finance &amp; Donations Ledger
          </h2>
          <p className={cx(styles, 'of-admin-subtitle')}>
            Configure transparent operating cost line items and strictly allowlisted HTTPS donation platforms.
            Zero payment custody and zero third-party payment scripts.
          </p>
        </div>
        {client && (
          <button
            type="button"
            className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
            disabled={loading}
            onClick={() => {
              void loadConfig();
            }}
          >
            {loading ? 'Loading…' : 'Reload Ledger'}
          </button>
        )}
      </div>

      {loadError && (
        <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
          <p>Could not load open-finance configuration: {loadError}</p>
        </div>
      )}

      {endpointDisabled && !loadError && (
        <div className={cx(wikiPanelStyles, 'wiki-status-banner')} role="status">
          <p>
            Server open-finance endpoints are not registered on this instance. Register{' '}
            <code>createOpenFinancePlugin()</code> in <code>@kinloom/server</code> to enable live editing.
          </p>
        </div>
      )}

      <div className={cx(styles, 'of-kpi-grid')}>
        <div className={cx(styles, 'of-kpi-card')}>
          <span className={cx(styles, 'of-kpi-label')}>Draft Monthly Cost</span>
          <span className={cx(styles, 'of-kpi-value')} data-testid="admin-of-monthly-preview">
            {formatUiCurrencyCents(previewTotals.monthly_operating_cents, draft.currency)}
          </span>
        </div>
        <div className={cx(styles, 'of-kpi-card')}>
          <span className={cx(styles, 'of-kpi-label')}>Draft Annual Cost</span>
          <span className={cx(styles, 'of-kpi-value')} data-testid="admin-of-annual-preview">
            {formatUiCurrencyCents(previewTotals.annual_operating_cents, draft.currency)}
          </span>
        </div>
        <div className={cx(styles, 'of-kpi-card')}>
          <span className={cx(styles, 'of-kpi-label')}>Configured Platforms</span>
          <span className={cx(styles, 'of-kpi-value')}>
            {draft.platforms.filter((p) => p.enabled).length}
          </span>
        </div>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <fieldset className={cx(styles, 'of-admin-fieldset')}>
          <legend className={cx(styles, 'of-admin-legend')}>Visibility &amp; Messaging</legend>
          <div className={cx(styles, 'of-admin-switches')}>
            <label className={cx(styles, 'of-switch-row')}>
              <input
                type="checkbox"
                className={cx(styles, 'of-switch-input')}
                checked={draft.showSupportPage}
                onChange={(e) => setDraft((prev) => ({ ...prev, showSupportPage: e.target.checked }))}
              />
              <span>Publish /support page</span>
            </label>
            <label className={cx(styles, 'of-switch-row')}>
              <input
                type="checkbox"
                className={cx(styles, 'of-switch-input')}
                checked={draft.showInNav}
                onChange={(e) => setDraft((prev) => ({ ...prev, showInNav: e.target.checked }))}
              />
              <span>Show in navigation</span>
            </label>
            <label className={cx(styles, 'of-switch-row')}>
              <input
                type="checkbox"
                className={cx(styles, 'of-switch-input')}
                checked={draft.showInFooter}
                onChange={(e) => setDraft((prev) => ({ ...prev, showInFooter: e.target.checked }))}
              />
              <span>Show in site footer</span>
            </label>
          </div>

          <div className={cx(styles, 'of-admin-grid')}>
            <div className={cx(styles, 'of-admin-field')}>
              <label htmlFor={`${idPrefix}-title`} className={cx(styles, 'of-admin-label')}>
                Page Title
              </label>
              <input
                id={`${idPrefix}-title`}
                type="text"
                className={cx(styles, 'of-admin-input')}
                value={draft.pageTitle}
                onChange={(e) => setDraft((prev) => ({ ...prev, pageTitle: e.target.value }))}
              />
              {fieldErrors['pageTitle'] && (
                <span className={cx(styles, 'of-field-error')}>{fieldErrors['pageTitle']}</span>
              )}
            </div>

            <div className={cx(styles, 'of-admin-field')}>
              <label htmlFor={`${idPrefix}-nav-label`} className={cx(styles, 'of-admin-label')}>
                Navigation &amp; Footer Label
              </label>
              <input
                id={`${idPrefix}-nav-label`}
                type="text"
                className={cx(styles, 'of-admin-input')}
                value={draft.navLabel}
                onChange={(e) => setDraft((prev) => ({ ...prev, navLabel: e.target.value }))}
              />
              {fieldErrors['navLabel'] && (
                <span className={cx(styles, 'of-field-error')}>{fieldErrors['navLabel']}</span>
              )}
            </div>

            <div className={cx(styles, 'of-admin-field')}>
              <label htmlFor={`${idPrefix}-currency`} className={cx(styles, 'of-admin-label')}>
                Currency
              </label>
              <select
                id={`${idPrefix}-currency`}
                className={cx(styles, 'of-admin-select')}
                value={draft.currency}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, currency: e.target.value as UiOpenFinanceCurrency }))
                }
              >
                {UI_OPEN_FINANCE_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={cx(styles, 'of-admin-field')} style={{ marginTop: 12 }}>
            <label htmlFor={`${idPrefix}-msg`} className={cx(styles, 'of-admin-label')}>
              Supporter Message
            </label>
            <textarea
              id={`${idPrefix}-msg`}
              className={cx(styles, 'of-admin-textarea')}
              value={draft.supporterMessage}
              onChange={(e) => setDraft((prev) => ({ ...prev, supporterMessage: e.target.value }))}
            />
          </div>
        </fieldset>

        <fieldset className={cx(styles, 'of-admin-fieldset')}>
          <legend className={cx(styles, 'of-admin-legend')}>
            Donation Platforms (Strict HTTPS Allowlist)
          </legend>

          {draft.platforms.map((row, idx) => {
            const spec = UI_DONATION_PLATFORM_REGISTRY[row.platform];
            const errKey = `platform.${row.platform}`;
            return (
              <div
                key={row.platform}
                className={cx(styles, 'of-admin-row-card')}
                data-testid={`admin-of-platform-${row.platform}`}
              >
                <div className={cx(styles, 'of-admin-row-head')}>
                  <strong>{spec.name}</strong>
                  <div className={cx(styles, 'of-admin-row-actions')}>
                    <label className={cx(styles, 'of-switch-row')}>
                      <input
                        type="radio"
                        name={`${idPrefix}-primary-platform`}
                        checked={draft.primaryPlatform === row.platform}
                        disabled={!row.enabled}
                        onChange={() => setDraft((prev) => ({ ...prev, primaryPlatform: row.platform }))}
                      />
                      <span>Primary CTA</span>
                    </label>
                    <label className={cx(styles, 'of-switch-row')}>
                      <input
                        type="checkbox"
                        className={cx(styles, 'of-switch-input')}
                        checked={row.enabled}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            platforms: prev.platforms.map((p) =>
                              p.platform === row.platform ? { ...p, enabled: e.target.checked } : p
                            ),
                          }))
                        }
                      />
                      <span>Enabled</span>
                    </label>
                    <button
                      type="button"
                      className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                      disabled={idx === 0}
                      onClick={() => handleMovePlatform(idx, -1)}
                    >
                      Move Up
                    </button>
                    <button
                      type="button"
                      className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                      disabled={idx === draft.platforms.length - 1}
                      onClick={() => handleMovePlatform(idx, 1)}
                    >
                      Move Down
                    </button>
                    <button
                      type="button"
                      className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                      onClick={() => handleRemovePlatform(row.platform)}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className={cx(styles, 'of-admin-grid')}>
                  <div className={cx(styles, 'of-admin-field')}>
                    <label
                      htmlFor={`${idPrefix}-plat-url-${row.platform}`}
                      className={cx(styles, 'of-admin-label')}
                    >
                      Allowlisted URL or Handle
                    </label>
                    <input
                      id={`${idPrefix}-plat-url-${row.platform}`}
                      type="text"
                      className={cx(styles, 'of-admin-input')}
                      placeholder={spec.placeholderUrl}
                      value={row.urlOrHandle}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          platforms: prev.platforms.map((p) =>
                            p.platform === row.platform ? { ...p, urlOrHandle: e.target.value } : p
                          ),
                        }))
                      }
                    />
                    <span className={cx(styles, 'of-field-help')}>
                      Format: {spec.canonicalPrefix}
                      {spec.handleExample}
                    </span>
                    {fieldErrors[errKey] && (
                      <span className={cx(styles, 'of-field-error')} role="alert">
                        {fieldErrors[errKey]}
                      </span>
                    )}
                  </div>

                  <div className={cx(styles, 'of-admin-field')}>
                    <label
                      htmlFor={`${idPrefix}-plat-label-${row.platform}`}
                      className={cx(styles, 'of-admin-label')}
                    >
                      Button Label
                    </label>
                    <input
                      id={`${idPrefix}-plat-label-${row.platform}`}
                      type="text"
                      className={cx(styles, 'of-admin-input')}
                      value={row.label}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          platforms: prev.platforms.map((p) =>
                            p.platform === row.platform ? { ...p, label: e.target.value } : p
                          ),
                        }))
                      }
                    />
                  </div>
                </div>
              </div>
            );
          })}

          {availablePlatformsToAdd.length > 0 && (
            <div className={cx(styles, 'of-admin-row-actions')}>
              <select
                aria-label="Choose donation platform to add"
                className={cx(styles, 'of-admin-select')}
                style={{ width: 'auto' }}
                value={platformToAdd}
                onChange={(e) => setPlatformToAdd(e.target.value as UiDonationPlatformId)}
              >
                {availablePlatformsToAdd.map((id) => (
                  <option key={id} value={id}>
                    {UI_DONATION_PLATFORM_REGISTRY[id].name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                onClick={handleAddPlatform}
              >
                Add Platform
              </button>
            </div>
          )}
        </fieldset>

        <fieldset className={cx(styles, 'of-admin-fieldset')}>
          <legend className={cx(styles, 'of-admin-legend')}>Operating Cost Breakdown</legend>
          {draft.costItems.map((item) => (
            <div
              key={item.id}
              className={cx(styles, 'of-admin-row-card')}
              data-testid={`admin-of-cost-${item.id}`}
            >
              <div className={cx(styles, 'of-admin-row-head')}>
                <strong>{item.label || item.id}</strong>
                <div className={cx(styles, 'of-admin-row-actions')}>
                  <label className={cx(styles, 'of-switch-row')}>
                    <input
                      type="checkbox"
                      className={cx(styles, 'of-switch-input')}
                      checked={item.active}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          costItems: prev.costItems.map((c) =>
                            c.id === item.id ? { ...c, active: e.target.checked } : c
                          ),
                        }))
                      }
                    />
                    <span>Active</span>
                  </label>
                  <button
                    type="button"
                    className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                    onClick={() => handleRemoveCostItem(item.id)}
                  >
                    Remove Item
                  </button>
                </div>
              </div>

              <div className={cx(styles, 'of-admin-grid')}>
                <div className={cx(styles, 'of-admin-field')}>
                  <label
                    htmlFor={`${idPrefix}-cost-label-${item.id}`}
                    className={cx(styles, 'of-admin-label')}
                  >
                    Item Label
                  </label>
                  <input
                    id={`${idPrefix}-cost-label-${item.id}`}
                    type="text"
                    className={cx(styles, 'of-admin-input')}
                    value={item.label}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        costItems: prev.costItems.map((c) =>
                          c.id === item.id ? { ...c, label: e.target.value } : c
                        ),
                      }))
                    }
                  />
                  {fieldErrors[`cost.${item.id}.label`] && (
                    <span className={cx(styles, 'of-field-error')}>
                      {fieldErrors[`cost.${item.id}.label`]}
                    </span>
                  )}
                </div>

                <div className={cx(styles, 'of-admin-field')}>
                  <label htmlFor={`${idPrefix}-cost-cat-${item.id}`} className={cx(styles, 'of-admin-label')}>
                    Category
                  </label>
                  <select
                    id={`${idPrefix}-cost-cat-${item.id}`}
                    className={cx(styles, 'of-admin-select')}
                    value={item.category}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        costItems: prev.costItems.map((c) =>
                          c.id === item.id
                            ? { ...c, category: e.target.value as UiOpenFinanceCostCategory }
                            : c
                        ),
                      }))
                    }
                  >
                    {UI_OPEN_FINANCE_COST_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {formatCostCategoryLabel(cat)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={cx(styles, 'of-admin-field')}>
                  <label htmlFor={`${idPrefix}-cost-cad-${item.id}`} className={cx(styles, 'of-admin-label')}>
                    Cadence
                  </label>
                  <select
                    id={`${idPrefix}-cost-cad-${item.id}`}
                    className={cx(styles, 'of-admin-select')}
                    value={item.cadence}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        costItems: prev.costItems.map((c) =>
                          c.id === item.id ? { ...c, cadence: e.target.value as UiOpenFinanceCostCadence } : c
                        ),
                      }))
                    }
                  >
                    {UI_OPEN_FINANCE_COST_CADENCES.map((cad) => (
                      <option key={cad} value={cad}>
                        {formatCostCadenceLabel(cad)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={cx(styles, 'of-admin-field')}>
                  <label htmlFor={`${idPrefix}-cost-amt-${item.id}`} className={cx(styles, 'of-admin-label')}>
                    Amount ({draft.currency})
                  </label>
                  <input
                    id={`${idPrefix}-cost-amt-${item.id}`}
                    type="text"
                    inputMode="decimal"
                    className={cx(styles, 'of-admin-input')}
                    value={item.amountText}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        costItems: prev.costItems.map((c) =>
                          c.id === item.id ? { ...c, amountText: e.target.value } : c
                        ),
                      }))
                    }
                  />
                  {fieldErrors[`cost.${item.id}.amount`] && (
                    <span className={cx(styles, 'of-field-error')}>
                      {fieldErrors[`cost.${item.id}.amount`]}
                    </span>
                  )}
                </div>

                <div className={cx(styles, 'of-admin-field')}>
                  <label
                    htmlFor={`${idPrefix}-cost-vendor-${item.id}`}
                    className={cx(styles, 'of-admin-label')}
                  >
                    Vendor (optional)
                  </label>
                  <input
                    id={`${idPrefix}-cost-vendor-${item.id}`}
                    type="text"
                    className={cx(styles, 'of-admin-input')}
                    value={item.vendor}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        costItems: prev.costItems.map((c) =>
                          c.id === item.id ? { ...c, vendor: e.target.value } : c
                        ),
                      }))
                    }
                  />
                </div>
              </div>
            </div>
          ))}

          <button
            type="button"
            className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
            onClick={handleAddCostItem}
          >
            Add Cost Item
          </button>
        </fieldset>

        <fieldset className={cx(styles, 'of-admin-fieldset')}>
          <legend className={cx(styles, 'of-admin-legend')}>Optional Funding Goal Progress</legend>
          <label className={cx(styles, 'of-switch-row')}>
            <input
              type="checkbox"
              className={cx(styles, 'of-switch-input')}
              checked={draft.goalEnabled}
              onChange={(e) => setDraft((prev) => ({ ...prev, goalEnabled: e.target.checked }))}
            />
            <span>Show funding goal progress bar</span>
          </label>
          {draft.goalEnabled && (
            <div className={cx(styles, 'of-admin-grid')}>
              <div className={cx(styles, 'of-admin-field')}>
                <label htmlFor={`${idPrefix}-goal-period`} className={cx(styles, 'of-admin-label')}>
                  Goal Period
                </label>
                <select
                  id={`${idPrefix}-goal-period`}
                  className={cx(styles, 'of-admin-select')}
                  value={draft.goalPeriod}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      goalPeriod: e.target.value === 'monthly' ? 'monthly' : 'annual',
                    }))
                  }
                >
                  <option value="annual">Annual</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div className={cx(styles, 'of-admin-field')}>
                <label htmlFor={`${idPrefix}-goal-target`} className={cx(styles, 'of-admin-label')}>
                  Target Amount (0 uses operating cost)
                </label>
                <input
                  id={`${idPrefix}-goal-target`}
                  type="text"
                  inputMode="decimal"
                  className={cx(styles, 'of-admin-input')}
                  value={draft.goalTargetText}
                  onChange={(e) => setDraft((prev) => ({ ...prev, goalTargetText: e.target.value }))}
                />
                {fieldErrors['goalTarget'] && (
                  <span className={cx(styles, 'of-field-error')}>{fieldErrors['goalTarget']}</span>
                )}
              </div>
              <div className={cx(styles, 'of-admin-field')}>
                <label htmlFor={`${idPrefix}-goal-received`} className={cx(styles, 'of-admin-label')}>
                  Received So Far
                </label>
                <input
                  id={`${idPrefix}-goal-received`}
                  type="text"
                  inputMode="decimal"
                  className={cx(styles, 'of-admin-input')}
                  value={draft.goalReceivedText}
                  onChange={(e) => setDraft((prev) => ({ ...prev, goalReceivedText: e.target.value }))}
                />
                {fieldErrors['goalReceived'] && (
                  <span className={cx(styles, 'of-field-error')}>{fieldErrors['goalReceived']}</span>
                )}
              </div>
              <div className={cx(styles, 'of-admin-field')}>
                <label htmlFor={`${idPrefix}-goal-label`} className={cx(styles, 'of-admin-label')}>
                  Goal Label (optional)
                </label>
                <input
                  id={`${idPrefix}-goal-label`}
                  type="text"
                  className={cx(styles, 'of-admin-input')}
                  value={draft.goalLabel}
                  onChange={(e) => setDraft((prev) => ({ ...prev, goalLabel: e.target.value }))}
                />
              </div>
              <div className={cx(styles, 'of-admin-field')}>
                <label htmlFor={`${idPrefix}-goal-date`} className={cx(styles, 'of-admin-label')}>
                  As-of Date (YYYY-MM-DD)
                </label>
                <input
                  id={`${idPrefix}-goal-date`}
                  type="text"
                  className={cx(styles, 'of-admin-input')}
                  placeholder="2026-11-01"
                  value={draft.goalAsOfDate}
                  onChange={(e) => setDraft((prev) => ({ ...prev, goalAsOfDate: e.target.value }))}
                />
                {fieldErrors['goalAsOfDate'] && (
                  <span className={cx(styles, 'of-field-error')}>{fieldErrors['goalAsOfDate']}</span>
                )}
              </div>
            </div>
          )}
        </fieldset>

        <div className={cx(styles, 'of-admin-footer')}>
          <div>
            {feedback.kind !== 'idle' && (
              <span
                className={cx(
                  styles,
                  `of-status-msg ${feedback.kind === 'success' ? 'is-success' : 'is-error'}`
                )}
                role={feedback.kind === 'error' ? 'alert' : 'status'}
              >
                {feedback.message}
              </span>
            )}
            {updatedAt && (
              <span className={cx(styles, 'of-field-help')} style={{ display: 'block' }}>
                Last updated {formatArchivalTimestamp(updatedAt)}
                {updatedBy ? ` by ${updatedBy}` : ''}
              </span>
            )}
          </div>
          {client && (
            <button
              type="submit"
              className={cx(wikiChromeStyles, 'wiki-btn-primary')}
              disabled={saving || endpointDisabled}
            >
              {saving ? 'Saving…' : 'Save Open Finance Settings'}
            </button>
          )}
        </div>
      </form>
    </section>
  );
};
