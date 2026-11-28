import type React from 'react';
import { useCallback, useEffect, useId, useState } from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import {
  BOOK_PUBLISHING_SERVER_PLUGIN_ID,
  formatBookByteSize,
  formatBookCurrencyCents,
  formatBookJobStatusLabel,
  UI_BOOK_BINDINGS,
  UI_BOOK_PAPER_STOCKS,
  UI_BOOK_SHIPPING_LEVELS,
  UI_BOOK_TRIM_PRESETS,
  type UiBookBindingStyle,
  type UiBookCompileResponse,
  type UiBookEdition,
  type UiBookEstimateResponse,
  type UiBookPaperStock,
  type UiBookPrintJob,
  type UiBookShippingLevel,
  type UiBookStatusResponse,
  type UiBookTrimPresetId,
  validateUiShippingAddress,
} from '../../lib/bookPublishingModel.js';
import { cx } from '../../lib/cx.js';
import layoutStyles from '../../styles/Layout.module.css';
import { useKinloomPlugins } from '../PluginContext.js';
import styles from './BookPublishing.module.css';
import { useBookPublishingContext } from './BookPublishingContext.js';

type ActionFeedback =
  | { readonly kind: 'idle' }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export const BookPublishingAdminPanel: React.FC = () => {
  const { client } = useBookPublishingContext();
  const { subscribePluginSettings } = useKinloomPlugins();
  const idPrefix = useId();

  const [status, setStatus] = useState<UiBookStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [endpointDisabled, setEndpointDisabled] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState<string>('');
  const [subtitle, setSubtitle] = useState<string>('');
  const [dedication, setDedication] = useState<string>('');
  const [trimPreset, setTrimPreset] = useState<UiBookTrimPresetId>('us-letter-landscape');
  const [binding, setBinding] = useState<UiBookBindingStyle>('hardcover-casewrap-glossy');
  const [paperStock, setPaperStock] = useState<UiBookPaperStock>('80lb-coated-white-color');
  const [branchId, setBranchId] = useState<string>('');
  const [edition, setEdition] = useState<UiBookEdition>('public');
  const [confirmPrivateLiving, setConfirmPrivateLiving] = useState<boolean>(false);
  const [acknowledgeReviewFlags, setAcknowledgeReviewFlags] = useState<boolean>(false);

  const [compiled, setCompiled] = useState<UiBookCompileResponse | null>(null);
  const [compiling, setCompiling] = useState<boolean>(false);

  const [recipientName, setRecipientName] = useState<string>('');
  const [street1, setStreet1] = useState<string>('');
  const [city, setCity] = useState<string>('');
  const [stateCode, setStateCode] = useState<string>('');
  const [postalCode, setPostalCode] = useState<string>('');
  const [countryCode, setCountryCode] = useState<string>('US');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [quantity, setQuantity] = useState<number>(1);
  const [shippingLevel, setShippingLevel] = useState<UiBookShippingLevel>('ground');
  const [confirmProductionOrder, setConfirmProductionOrder] = useState<boolean>(false);

  const [estimate, setEstimate] = useState<UiBookEstimateResponse | null>(null);
  const [estimating, setEstimating] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [jobs, setJobs] = useState<readonly UiBookPrintJob[]>([]);
  const [refreshingJobId, setRefreshingJobId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback>({ kind: 'idle' });

  const loadStatus = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await client.getStatus(signal ? { signal } : {});
        if (signal?.aborted) {
          return;
        }
        if (result === null) {
          setEndpointDisabled(true);
          setStatus(null);
        } else {
          setEndpointDisabled(false);
          setStatus(result);
          setTrimPreset(result.defaults.trim_preset);
          setBinding(result.defaults.binding);
          setPaperStock(result.defaults.paper_stock);
          setShippingLevel(result.defaults.shipping_level);
          setJobs(result.jobs);
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
    [client]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadStatus]);

  useEffect(() => {
    return subscribePluginSettings(BOOK_PUBLISHING_SERVER_PLUGIN_ID, (evt) => {
      if (evt.source === 'plugin-settings-section') {
        void loadStatus();
      }
    });
  }, [subscribePluginSettings, loadStatus]);

  const effectivePages = compiled?.report.counts.finalPageCount ?? status?.readiness?.estimated_pages ?? 24;
  const isProductionMode = status?.publisher_provider === 'lulu' && status?.environment === 'production';

  const handleCompile = async (): Promise<void> => {
    if (compiling) {
      return;
    }
    if (edition === 'private' && !confirmPrivateLiving) {
      setFeedback({
        kind: 'error',
        message: 'Confirm the Private Family Edition living-relatives notice before compiling.',
      });
      return;
    }
    setFeedback({ kind: 'idle' });
    setCompiling(true);
    try {
      const result = await client.compileBook({
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(subtitle.trim() ? { subtitle: subtitle.trim() } : {}),
        ...(dedication.trim() ? { dedication: dedication.trim() } : {}),
        trimPreset,
        binding,
        paperStock,
        edition,
        includeLiving: edition === 'private' ? confirmPrivateLiving : false,
        acknowledgeReviewFlags,
        ...(branchId ? { branchId } : {}),
      });
      setCompiled(result);
      setFeedback({
        kind: 'success',
        message: `Compiled ${result.report.counts.finalPageCount}-page ${result.report.edition} hardcover book PDFs.`,
      });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setCompiling(false);
    }
  };

  const buildShippingAddress = () => ({
    name: recipientName.trim(),
    street1: street1.trim(),
    city: city.trim(),
    ...(stateCode.trim() ? { stateCode: stateCode.trim() } : {}),
    countryCode: countryCode.trim().toUpperCase(),
    postalCode: postalCode.trim(),
    phoneNumber: phoneNumber.trim(),
  });

  const handleEstimate = async (): Promise<void> => {
    if (estimating) {
      return;
    }
    const address = buildShippingAddress();
    const validationErr = validateUiShippingAddress(address);
    if (validationErr) {
      setFeedback({ kind: 'error', message: validationErr });
      return;
    }
    setFeedback({ kind: 'idle' });
    setEstimating(true);
    try {
      const result = await client.estimateCost({
        trimPreset,
        binding,
        paperStock,
        interiorPageCount: effectivePages,
        quantity,
        shippingLevel,
        shippingAddress: address,
      });
      setEstimate(result);
      setFeedback({
        kind: 'success',
        message: `Estimated total: ${formatBookCurrencyCents(result.quote.totalCostCents, result.quote.currency)} (${result.quote.providerSku}).`,
      });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setEstimating(false);
    }
  };

  const handleSubmitJob = async (): Promise<void> => {
    if (submitting) {
      return;
    }
    if (edition === 'private' && !confirmPrivateLiving) {
      setFeedback({
        kind: 'error',
        message: 'Confirm the Private Family Edition notice before submitting.',
      });
      return;
    }
    if (isProductionMode && !confirmProductionOrder) {
      setFeedback({
        kind: 'error',
        message: 'Confirm the paid production print order checkbox before submitting.',
      });
      return;
    }
    const address = buildShippingAddress();
    const validationErr = validateUiShippingAddress(address);
    if (validationErr) {
      setFeedback({ kind: 'error', message: validationErr });
      return;
    }
    setFeedback({ kind: 'idle' });
    setSubmitting(true);
    try {
      const result = await client.submitPrintJob({
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(subtitle.trim() ? { subtitle: subtitle.trim() } : {}),
        ...(dedication.trim() ? { dedication: dedication.trim() } : {}),
        trimPreset,
        binding,
        paperStock,
        edition,
        includeLiving: edition === 'private' ? confirmPrivateLiving : false,
        acknowledgeReviewFlags,
        ...(branchId ? { branchId } : {}),
        quantity,
        shippingLevel,
        shippingAddress: address,
        confirmProduction: isProductionMode ? confirmProductionOrder : false,
      });
      setJobs((prev) => [result.job, ...prev.filter((j) => j.jobId !== result.job.jobId)]);
      setFeedback({
        kind: 'success',
        message: `Submitted print job ${result.job.jobId} (${formatBookJobStatusLabel(result.job.status)}).`,
      });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefreshJob = async (jobId: string): Promise<void> => {
    setRefreshingJobId(jobId);
    try {
      const updated = await client.getJobStatus(jobId);
      setJobs((prev) => prev.map((j) => (j.jobId === jobId ? updated : j)));
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRefreshingJobId(null);
    }
  };

  const headingId = `${idPrefix}-book-pub-heading`;

  return (
    <section
      className={cx(layoutStyles, 'place-map-box')}
      aria-labelledby={headingId}
      data-testid="admin-book-publishing-panel"
    >
      <div className={cx(styles, 'bp-header')}>
        <div>
          <h2 id={headingId} className={cx(wikiPanelStyles, 'wiki-section-title')}>
            Archival Hardcover Book Publishing
          </h2>
          <p className={cx(styles, 'bp-subtitle')}>
            Compile print-ready landscape hardcover interior and wraparound cover PDFs with mandatory
            living-person privacy redaction, estimate Lulu Print API shipping costs, and track print jobs.
          </p>
        </div>
        <button
          type="button"
          className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
          disabled={loading}
          onClick={() => {
            void loadStatus();
          }}
        >
          {loading ? 'Loading…' : 'Refresh Readiness'}
        </button>
      </div>

      {loadError && (
        <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
          <p>Could not load book publishing status: {loadError}</p>
        </div>
      )}

      {endpointDisabled && !loadError && (
        <div
          className={cx(wikiPanelStyles, 'wiki-status-banner')}
          role="status"
          data-testid="bp-disabled-banner"
        >
          <p>
            Server book publishing endpoints are not registered on this instance. Register{' '}
            <code>createBookPublishingServerPlugin()</code> in <code>@kinloom/server</code> to enable book
            compilation and print-on-demand fulfillment.
          </p>
        </div>
      )}

      {status && (
        <>
          <div className={cx(styles, 'bp-kpi-grid')}>
            <div className={cx(styles, 'bp-kpi-card')}>
              <span className={cx(styles, 'bp-kpi-label')}>Publisher Adapter</span>
              <span className={cx(styles, 'bp-kpi-value')} data-testid="bp-active-publisher">
                {status.active_publisher}
              </span>
              <span className={cx(styles, 'bp-kpi-meta')}>Renderer: {status.pdf_renderer}</span>
            </div>
            <div className={cx(styles, 'bp-kpi-card')}>
              <span className={cx(styles, 'bp-kpi-label')}>Redacted Readiness</span>
              <span className={cx(styles, 'bp-kpi-value')} data-testid="bp-included-people">
                {status.readiness?.included_people ?? 0} people
              </span>
              <span className={cx(styles, 'bp-kpi-meta')}>
                {status.readiness?.excluded_living_people ?? 0} living excluded by default
              </span>
            </div>
            <div className={cx(styles, 'bp-kpi-card')}>
              <span className={cx(styles, 'bp-kpi-label')}>Est. Hardcover Length</span>
              <span className={cx(styles, 'bp-kpi-value')} data-testid="bp-estimated-pages">
                {effectivePages} pp
              </span>
              <span className={cx(styles, 'bp-kpi-meta')}>
                Spine:{' '}
                {compiled?.report.coverDimensions.spineWidthIn ?? status.readiness?.spine_width_in ?? 0.25} in
              </span>
            </div>
          </div>

          <fieldset className={cx(styles, 'bp-fieldset')}>
            <legend className={cx(styles, 'bp-legend')}>
              1. Edition, Scope &amp; Prepress Specification
            </legend>
            <div className={cx(styles, 'bp-grid')}>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-title`} className={cx(styles, 'bp-label')}>
                  Book Title (Optional Override)
                </label>
                <input
                  id={`${idPrefix}-title`}
                  type="text"
                  className={cx(styles, 'bp-input')}
                  placeholder="Defaults to archive title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-subtitle`} className={cx(styles, 'bp-label')}>
                  Subtitle
                </label>
                <input
                  id={`${idPrefix}-subtitle`}
                  type="text"
                  className={cx(styles, 'bp-input')}
                  placeholder="Optional archival subtitle"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-trim`} className={cx(styles, 'bp-label')}>
                  Landscape Trim Size
                </label>
                <select
                  id={`${idPrefix}-trim`}
                  className={cx(styles, 'bp-select')}
                  value={trimPreset}
                  onChange={(e) => setTrimPreset(e.target.value as UiBookTrimPresetId)}
                >
                  {UI_BOOK_TRIM_PRESETS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-binding`} className={cx(styles, 'bp-label')}>
                  Hardcover Binding
                </label>
                <select
                  id={`${idPrefix}-binding`}
                  className={cx(styles, 'bp-select')}
                  value={binding}
                  onChange={(e) => setBinding(e.target.value as UiBookBindingStyle)}
                >
                  {UI_BOOK_BINDINGS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-paper`} className={cx(styles, 'bp-label')}>
                  Paper Stock
                </label>
                <select
                  id={`${idPrefix}-paper`}
                  className={cx(styles, 'bp-select')}
                  value={paperStock}
                  onChange={(e) => setPaperStock(e.target.value as UiBookPaperStock)}
                >
                  {UI_BOOK_PAPER_STOCKS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-branch`} className={cx(styles, 'bp-label')}>
                  Lineage Scope
                </label>
                <select
                  id={`${idPrefix}-branch`}
                  className={cx(styles, 'bp-select')}
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                >
                  <option value="">Entire Archive</option>
                  {status.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-edition`} className={cx(styles, 'bp-label')}>
                  Privacy Edition
                </label>
                <select
                  id={`${idPrefix}-edition`}
                  className={cx(styles, 'bp-select')}
                  value={edition}
                  onChange={(e) => {
                    setEdition(e.target.value as UiBookEdition);
                    setConfirmPrivateLiving(false);
                  }}
                >
                  <option value="public">Public Redacted Edition (Default Safe)</option>
                  <option value="private">Private Family Edition (Includes Living)</option>
                </select>
              </div>
            </div>

            <div className={cx(styles, 'bp-field')} style={{ marginTop: 10 }}>
              <label htmlFor={`${idPrefix}-dedication`} className={cx(styles, 'bp-label')}>
                Dedication Page Note (Optional)
              </label>
              <textarea
                id={`${idPrefix}-dedication`}
                className={cx(styles, 'bp-textarea')}
                placeholder="For future generations of the family…"
                value={dedication}
                onChange={(e) => setDedication(e.target.value)}
              />
            </div>

            {edition === 'private' && (
              <div className={cx(styles, 'bp-warning-box')} role="alert">
                <strong>Private Family Edition Warning:</strong> This edition includes living relatives and
                stamps “Private Family Edition. Not for Public Distribution.” on the colophon.
                <label className={cx(styles, 'bp-checkbox-row')}>
                  <input
                    type="checkbox"
                    className={cx(styles, 'bp-checkbox-input')}
                    checked={confirmPrivateLiving}
                    onChange={(e) => setConfirmPrivateLiving(e.target.checked)}
                    data-testid="bp-confirm-private-checkbox"
                  />
                  <span>I confirm this book is strictly for private family distribution.</span>
                </label>
              </div>
            )}

            {(status.readiness?.review_flags_detected ?? 0) > 0 && edition === 'public' && (
              <label className={cx(styles, 'bp-checkbox-row')}>
                <input
                  type="checkbox"
                  className={cx(styles, 'bp-checkbox-input')}
                  checked={acknowledgeReviewFlags}
                  onChange={(e) => setAcknowledgeReviewFlags(e.target.checked)}
                />
                <span>
                  Acknowledge {status.readiness?.review_flags_detected} living-person mention review flag(s)
                  (names are scrubbed in public edition).
                </span>
              </label>
            )}

            <div className={cx(styles, 'bp-actions-row')}>
              <button
                type="button"
                className={cx(wikiChromeStyles, 'wiki-btn-primary')}
                disabled={compiling}
                onClick={() => {
                  void handleCompile();
                }}
                data-testid="bp-compile-btn"
              >
                {compiling ? 'Compiling PDFs…' : 'Preview & Generate Local PDFs'}
              </button>
            </div>

            {compiled && (
              <div className={cx(styles, 'bp-artifact-box')} data-testid="bp-compiled-preview">
                <strong>
                  {compiled.report.title} — {compiled.report.counts.finalPageCount} pages (
                  {compiled.report.coverDimensions.totalWidthIn} ×{' '}
                  {compiled.report.coverDimensions.totalHeightIn} in cover, spine{' '}
                  {compiled.report.coverDimensions.spineWidthIn} in)
                </strong>
                <p className={cx(styles, 'bp-job-meta')}>
                  SKU: {compiled.report.coverDimensions.providerSku} · Living excluded:{' '}
                  {compiled.report.counts.excludedLivingPeople} · Spine text:{' '}
                  {compiled.report.coverDimensions.allowSpineText ? 'Enabled' : 'Omitted (< 80 pp)'}
                </p>
                <div className={cx(styles, 'bp-artifact-links')}>
                  <a
                    href={compiled.artifacts.interior_pdf_url}
                    target="_blank"
                    rel="noreferrer"
                    className={cx(styles, 'bp-download-link')}
                    data-testid="bp-download-interior"
                  >
                    Download Interior PDF ({formatBookByteSize(compiled.artifacts.interior_bytes)})
                  </a>
                  <a
                    href={compiled.artifacts.cover_pdf_url}
                    target="_blank"
                    rel="noreferrer"
                    className={cx(styles, 'bp-download-link')}
                    data-testid="bp-download-cover"
                  >
                    Download Cover PDF ({formatBookByteSize(compiled.artifacts.cover_bytes)})
                  </a>
                </div>
              </div>
            )}
          </fieldset>

          <fieldset className={cx(styles, 'bp-fieldset')}>
            <legend className={cx(styles, 'bp-legend')}>
              2. Print-on-Demand Quote &amp; Order Submission
            </legend>
            <div className={cx(styles, 'bp-grid')}>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-ship-name`} className={cx(styles, 'bp-label')}>
                  Recipient Name
                </label>
                <input
                  id={`${idPrefix}-ship-name`}
                  type="text"
                  className={cx(styles, 'bp-input')}
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-ship-street`} className={cx(styles, 'bp-label')}>
                  Street Address
                </label>
                <input
                  id={`${idPrefix}-ship-street`}
                  type="text"
                  className={cx(styles, 'bp-input')}
                  value={street1}
                  onChange={(e) => setStreet1(e.target.value)}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-ship-city`} className={cx(styles, 'bp-label')}>
                  City
                </label>
                <input
                  id={`${idPrefix}-ship-city`}
                  type="text"
                  className={cx(styles, 'bp-input')}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-ship-state`} className={cx(styles, 'bp-label')}>
                  State / Region
                </label>
                <input
                  id={`${idPrefix}-ship-state`}
                  type="text"
                  className={cx(styles, 'bp-input')}
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value)}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-ship-postal`} className={cx(styles, 'bp-label')}>
                  Postal Code
                </label>
                <input
                  id={`${idPrefix}-ship-postal`}
                  type="text"
                  className={cx(styles, 'bp-input')}
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-ship-country`} className={cx(styles, 'bp-label')}>
                  Country (ISO-2)
                </label>
                <input
                  id={`${idPrefix}-ship-country`}
                  type="text"
                  maxLength={2}
                  className={cx(styles, 'bp-input')}
                  value={countryCode}
                  onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-ship-phone`} className={cx(styles, 'bp-label')}>
                  Phone Number
                </label>
                <input
                  id={`${idPrefix}-ship-phone`}
                  type="tel"
                  className={cx(styles, 'bp-input')}
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-qty`} className={cx(styles, 'bp-label')}>
                  Quantity
                </label>
                <input
                  id={`${idPrefix}-qty`}
                  type="number"
                  min={1}
                  max={250}
                  className={cx(styles, 'bp-input')}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                />
              </div>
              <div className={cx(styles, 'bp-field')}>
                <label htmlFor={`${idPrefix}-ship-level`} className={cx(styles, 'bp-label')}>
                  Shipping Speed
                </label>
                <select
                  id={`${idPrefix}-ship-level`}
                  className={cx(styles, 'bp-select')}
                  value={shippingLevel}
                  onChange={(e) => setShippingLevel(e.target.value as UiBookShippingLevel)}
                >
                  {UI_BOOK_SHIPPING_LEVELS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {estimate && (
              <div className={cx(styles, 'bp-quote-grid')} data-testid="bp-quote-summary">
                <div className={cx(styles, 'bp-kpi-card')}>
                  <span className={cx(styles, 'bp-kpi-label')}>Manufacturing</span>
                  <span className={cx(styles, 'bp-kpi-value')}>
                    {formatBookCurrencyCents(estimate.quote.manufacturingCostCents, estimate.quote.currency)}
                  </span>
                </div>
                <div className={cx(styles, 'bp-kpi-card')}>
                  <span className={cx(styles, 'bp-kpi-label')}>Shipping</span>
                  <span className={cx(styles, 'bp-kpi-value')}>
                    {formatBookCurrencyCents(estimate.quote.shippingCostCents, estimate.quote.currency)}
                  </span>
                </div>
                <div className={cx(styles, 'bp-kpi-card')}>
                  <span className={cx(styles, 'bp-kpi-label')}>Tax &amp; Fees</span>
                  <span className={cx(styles, 'bp-kpi-value')}>
                    {formatBookCurrencyCents(
                      estimate.quote.taxCents + estimate.quote.fulfillmentFeeCents,
                      estimate.quote.currency
                    )}
                  </span>
                </div>
                <div className={cx(styles, 'bp-kpi-card')}>
                  <span className={cx(styles, 'bp-kpi-label')}>Estimated Total</span>
                  <span className={cx(styles, 'bp-kpi-value')} data-testid="bp-quote-total">
                    {formatBookCurrencyCents(estimate.quote.totalCostCents, estimate.quote.currency)}
                  </span>
                </div>
              </div>
            )}

            {isProductionMode && (
              <div className={cx(styles, 'bp-warning-box')} role="alert">
                <strong>Production Mode Active:</strong> Submitting places a real paid hardcover print order
                with Lulu Print API
                {estimate
                  ? ` (${formatBookCurrencyCents(estimate.quote.totalCostCents, estimate.quote.currency)} to ${recipientName || 'recipient'})`
                  : ''}
                .
                <label className={cx(styles, 'bp-checkbox-row')}>
                  <input
                    type="checkbox"
                    className={cx(styles, 'bp-checkbox-input')}
                    checked={confirmProductionOrder}
                    onChange={(e) => setConfirmProductionOrder(e.target.checked)}
                    data-testid="bp-confirm-production-checkbox"
                  />
                  <span>I confirm this paid production print order and shipping address.</span>
                </label>
              </div>
            )}

            <div className={cx(styles, 'bp-actions-row')}>
              <button
                type="button"
                className={cx(wikiChromeStyles, 'wiki-btn-secondary')}
                disabled={estimating}
                onClick={() => {
                  void handleEstimate();
                }}
                data-testid="bp-estimate-btn"
              >
                {estimating ? 'Estimating…' : 'Estimate Print & Shipping Cost'}
              </button>
              <button
                type="button"
                className={cx(wikiChromeStyles, 'wiki-btn-primary')}
                disabled={submitting}
                onClick={() => {
                  void handleSubmitJob();
                }}
                data-testid="bp-submit-job-btn"
              >
                {submitting
                  ? 'Submitting…'
                  : isProductionMode
                    ? 'Submit Paid Print Order'
                    : 'Submit Sandbox Test Order'}
              </button>
            </div>
          </fieldset>

          {feedback.kind !== 'idle' && (
            <p
              role={feedback.kind === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              className={cx(
                styles,
                feedback.kind === 'success' ? 'bp-feedback is-success' : 'bp-feedback is-error'
              )}
              data-testid="bp-feedback"
            >
              {feedback.message}
            </p>
          )}

          {jobs.length > 0 && (
            <fieldset className={cx(styles, 'bp-fieldset')}>
              <legend className={cx(styles, 'bp-legend')}>3. Print Job Status Tracker</legend>
              <div className={cx(styles, 'bp-job-list')} data-testid="bp-jobs-list">
                {jobs.map((job) => (
                  <div
                    key={job.jobId}
                    className={cx(styles, 'bp-job-row')}
                    data-testid={`bp-job-${job.jobId}`}
                  >
                    <div>
                      <strong>{job.title}</strong>{' '}
                      <span className={cx(styles, 'bp-status-pill')}>
                        {formatBookJobStatusLabel(job.status)}
                      </span>
                      <div className={cx(styles, 'bp-job-meta')}>
                        ID: {job.jobId} · Qty: {job.quantity} · {job.sandbox ? 'Sandbox' : 'Production'}
                        {job.trackingUrls.length > 0 ? ` · Tracking: ${job.trackingUrls.join(', ')}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                      disabled={refreshingJobId === job.jobId}
                      onClick={() => {
                        void handleRefreshJob(job.jobId);
                      }}
                    >
                      {refreshingJobId === job.jobId ? 'Checking…' : 'Refresh Status'}
                    </button>
                  </div>
                ))}
              </div>
            </fieldset>
          )}
        </>
      )}
    </section>
  );
};
