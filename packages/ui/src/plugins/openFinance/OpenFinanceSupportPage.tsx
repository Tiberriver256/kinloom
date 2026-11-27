import type React from 'react';
import { useId } from 'react';
import { ArchivalPageShell } from '../../components/ArchivalLayout.js';
import { ExplorerTopBar } from '../../components/ExplorerTopBar.js';
import { KinloomFooter } from '../../components/KinloomFooter.js';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import {
  formatCostCadenceLabel,
  formatCostCategoryLabel,
  formatUiCurrencyCents,
  validateUiDonationPlatformUrl,
} from '../../lib/openFinanceModel.js';
import styles from './OpenFinance.module.css';
import { useOpenFinanceContext } from './OpenFinanceContext.js';

export const OpenFinanceSupportPage: React.FC = () => {
  const { summary, loading, error } = useOpenFinanceContext();
  const idPrefix = useId();

  const goalHeadingId = `${idPrefix}-goal-heading`;
  const platformsHeadingId = `${idPrefix}-platforms-heading`;
  const ledgerHeadingId = `${idPrefix}-ledger-heading`;

  const renderContent = (): React.ReactNode => {
    if (loading && !summary) {
      return (
        <section className={cx(styles, 'of-section')} aria-live="polite" data-testid="open-finance-loading">
          <p className={cx(styles, 'of-message')}>Loading open-finance ledger…</p>
        </section>
      );
    }

    if (error && !summary) {
      return (
        <section className={cx(styles, 'of-section')} role="alert" data-testid="open-finance-error">
          <h1 className={cx(styles, 'of-title')}>Open Finance &amp; Support</h1>
          <p className={cx(styles, 'of-message')}>Could not load archive operating cost details: {error}</p>
        </section>
      );
    }

    if (!summary?.visibility.show_support_page) {
      return (
        <section className={cx(styles, 'of-section')} data-testid="open-finance-unpublished">
          <h1 className={cx(styles, 'of-title')}>Open Finance &amp; Support</h1>
          <p className={cx(styles, 'of-message')}>
            This archive has not published a public open-finance or donation page.
          </p>
        </section>
      );
    }

    const safePlatforms = summary.platforms
      .map((entry) => {
        const checked = validateUiDonationPlatformUrl(entry.platform, entry.url);
        if (!checked.ok) {
          return null;
        }
        return { ...entry, url: checked.url, host: checked.host };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const { totals, currency, funding_goal: fundingGoal } = summary;
    const progressMax = fundingGoal && fundingGoal.target_cents > 0 ? fundingGoal.target_cents : 1;
    const progressVal = fundingGoal ? Math.min(progressMax, fundingGoal.received_cents) : 0;

    return (
      <div data-testid="open-finance-support-page">
        <header className={cx(styles, 'of-hero')}>
          <p className={cx(styles, 'of-eyebrow')}>Open Operating Ledger</p>
          <h1 className={cx(styles, 'of-title')}>{summary.page_title}</h1>
          {summary.supporter_message && (
            <p className={cx(styles, 'of-message')}>{summary.supporter_message}</p>
          )}
          <p className={cx(styles, 'of-custody-note')}>
            Zero payment custody: contributions open directly on the listed external HTTPS platforms. This
            archive never collects payment cards or loads third-party payment scripts.
          </p>
        </header>

        <section className={cx(styles, 'of-kpi-grid')} aria-label="Operating cost totals">
          <div className={cx(styles, 'of-kpi-card')}>
            <span className={cx(styles, 'of-kpi-label')}>Monthly Operating Cost</span>
            <span className={cx(styles, 'of-kpi-value')} data-testid="open-finance-monthly-total">
              {formatUiCurrencyCents(totals.monthly_operating_cents, currency)}
            </span>
            <span className={cx(styles, 'of-kpi-meta')}>Amortized recurring cost / month</span>
          </div>
          <div className={cx(styles, 'of-kpi-card')}>
            <span className={cx(styles, 'of-kpi-label')}>Annual Operating Cost</span>
            <span className={cx(styles, 'of-kpi-value')} data-testid="open-finance-annual-total">
              {formatUiCurrencyCents(totals.annual_operating_cents, currency)}
            </span>
            <span className={cx(styles, 'of-kpi-meta')}>
              {totals.active_item_count} {totals.active_item_count === 1 ? 'line item' : 'line items'} tracked
            </span>
          </div>
          {totals.one_time_cents > 0 && (
            <div className={cx(styles, 'of-kpi-card')}>
              <span className={cx(styles, 'of-kpi-label')}>One-Time Expenses</span>
              <span className={cx(styles, 'of-kpi-value')} data-testid="open-finance-onetime-total">
                {formatUiCurrencyCents(totals.one_time_cents, currency)}
              </span>
              <span className={cx(styles, 'of-kpi-meta')}>
                First-year total {formatUiCurrencyCents(totals.first_year_total_cents, currency)}
              </span>
            </div>
          )}
          <div className={cx(styles, 'of-kpi-card')}>
            <span className={cx(styles, 'of-kpi-label')}>Donation Platforms</span>
            <span className={cx(styles, 'of-kpi-value')}>{safePlatforms.length}</span>
            <span className={cx(styles, 'of-kpi-meta')}>Allowlisted HTTPS channels</span>
          </div>
        </section>

        {fundingGoal && (
          <section
            className={cx(styles, 'of-section')}
            aria-labelledby={goalHeadingId}
            data-testid="open-finance-funding-goal"
          >
            <div className={cx(styles, 'of-goal-header')}>
              <h2 id={goalHeadingId} className={cx(styles, 'of-goal-label')}>
                {fundingGoal.label ||
                  (fundingGoal.period === 'monthly' ? 'Monthly Hosting Goal' : 'Annual Archive Hosting Goal')}
              </h2>
              <span className={cx(styles, 'of-goal-figures')}>
                {formatUiCurrencyCents(fundingGoal.received_cents, currency)} of{' '}
                {formatUiCurrencyCents(fundingGoal.target_cents, currency)} ({fundingGoal.raw_percent}%)
              </span>
            </div>
            <progress
              className={cx(styles, 'of-progress')}
              value={progressVal}
              max={progressMax}
              aria-labelledby={goalHeadingId}
            />
            <p className={cx(styles, 'of-goal-footnote')}>
              {fundingGoal.remaining_cents > 0
                ? `${formatUiCurrencyCents(fundingGoal.remaining_cents, currency)} remaining toward the ${fundingGoal.period} target.`
                : `The ${fundingGoal.period} operating cost target is fully funded.`}
              {fundingGoal.as_of_date ? ` Updated as of ${fundingGoal.as_of_date}.` : ''}
            </p>
          </section>
        )}

        {safePlatforms.length > 0 && (
          <section
            className={cx(styles, 'of-section')}
            aria-labelledby={platformsHeadingId}
            data-testid="open-finance-platforms"
          >
            <div className={cx(styles, 'of-section-head')}>
              <h2 id={platformsHeadingId} className={cx(styles, 'of-section-title')}>
                Ways to Support the Archive
              </h2>
              <span className={cx(styles, 'of-section-meta')}>External allowlisted HTTPS links</span>
            </div>
            <div className={cx(styles, 'of-platform-grid')}>
              {safePlatforms.map((platform) => (
                <article
                  key={platform.platform}
                  className={cx(styles, `of-platform-card ${platform.is_primary ? 'is-primary' : ''}`)}
                  data-platform={platform.platform}
                  data-primary={platform.is_primary ? 'true' : 'false'}
                >
                  <div>
                    <div className={cx(styles, 'of-platform-top')}>
                      <span className={cx(styles, 'of-platform-name')}>{platform.name}</span>
                      {platform.is_primary && <span className={cx(styles, 'of-primary-badge')}>Primary</span>}
                    </div>
                    <div className={cx(styles, 'of-platform-host')}>
                      {platform.host}/{platform.handle}
                    </div>
                    {platform.description && (
                      <p className={cx(styles, 'of-platform-desc')}>{platform.description}</p>
                    )}
                  </div>
                  <a
                    href={platform.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cx(styles, `of-cta-link ${platform.is_primary ? 'is-primary' : ''}`)}
                  >
                    {platform.label}
                  </a>
                </article>
              ))}
            </div>
          </section>
        )}

        <section
          className={cx(styles, 'of-section')}
          aria-labelledby={ledgerHeadingId}
          data-testid="open-finance-ledger"
        >
          <div className={cx(styles, 'of-section-head')}>
            <h2 id={ledgerHeadingId} className={cx(styles, 'of-section-title')}>
              Transparent Operating Cost Breakdown
            </h2>
            {summary.updated_at && (
              <span className={cx(styles, 'of-section-meta')}>
                Updated {formatArchivalTimestamp(summary.updated_at)}
              </span>
            )}
          </div>

          {summary.cost_items.length === 0 ? (
            <p className={cx(styles, 'of-message')}>No operating cost line items have been published yet.</p>
          ) : (
            <div
              // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-scrollable responsive table region per WCAG
              tabIndex={0}
              role="region"
              aria-labelledby={ledgerHeadingId}
              className={cx(styles, 'of-table-wrapper')}
            >
              <table className={cx(styles, 'of-table')}>
                <thead>
                  <tr>
                    <th scope="col">Expense</th>
                    <th scope="col">Category</th>
                    <th scope="col">Cadence</th>
                    <th scope="col">Vendor</th>
                    <th scope="col" className={cx(styles, 'of-table-num')}>
                      Billed Amount
                    </th>
                    <th scope="col" className={cx(styles, 'of-table-num')}>
                      Monthly Equiv.
                    </th>
                    <th scope="col" className={cx(styles, 'of-table-num')}>
                      Annual Equiv.
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.cost_items.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        {item.label}
                        {item.notes && <span className={cx(styles, 'of-item-notes')}>{item.notes}</span>}
                      </th>
                      <td data-label="Category">
                        <span className={cx(styles, 'of-pill')}>
                          {formatCostCategoryLabel(item.category)}
                        </span>
                      </td>
                      <td data-label="Cadence">{formatCostCadenceLabel(item.cadence)}</td>
                      <td data-label="Vendor">{item.vendor ?? '—'}</td>
                      <td data-label="Billed Amount" className={cx(styles, 'of-table-num')}>
                        {formatUiCurrencyCents(item.amount_cents, currency)}
                      </td>
                      <td data-label="Monthly Equiv." className={cx(styles, 'of-table-num')}>
                        {item.cadence === 'one_time'
                          ? '—'
                          : formatUiCurrencyCents(item.monthly_equivalent_cents, currency)}
                      </td>
                      <td data-label="Annual Equiv." className={cx(styles, 'of-table-num')}>
                        {item.cadence === 'one_time'
                          ? '—'
                          : formatUiCurrencyCents(item.annual_equivalent_cents, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={5}>
                      Recurring Operating Totals
                    </th>
                    <td data-label="Monthly Total" className={cx(styles, 'of-table-num')}>
                      {formatUiCurrencyCents(totals.monthly_operating_cents, currency)}
                    </td>
                    <td data-label="Annual Total" className={cx(styles, 'of-table-num')}>
                      {formatUiCurrencyCents(totals.annual_operating_cents, currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>
    );
  };

  return (
    <div>
      <ExplorerTopBar />
      <ArchivalPageShell variant="standard">{renderContent()}</ArchivalPageShell>
      <KinloomFooter />
    </div>
  );
};
