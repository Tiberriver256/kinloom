import {
  isSecretPluginSettingField,
  type PluginSettingField,
  type PluginSettingsSnapshot,
  type PluginSettingsUpdateRequest,
} from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import {
  buildPluginSettingsSubmitPayload,
  createPluginSettingsDraft,
  extractPluginSettingsApiFieldErrors,
  formatReadonlySettingValue,
  isPluginSettingsDraftDirty,
  type PluginSettingsFormDraft,
  updateDraftFieldValue,
  updateDraftSecretState,
  validateSingleDraftField,
} from '../../lib/pluginSettingsForm.js';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import styles from './PluginSettingsSection.module.css';

export interface PluginSettingsSectionProps {
  readonly plugins: readonly PluginSettingsSnapshot[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly supported: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onUpdatePlugin: (
    pluginId: string,
    input: PluginSettingsUpdateRequest
  ) => Promise<PluginSettingsSnapshot>;
}

type FormSubmitFeedback =
  | { readonly kind: 'idle' }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

interface PluginSettingsCardProps {
  readonly snapshot: PluginSettingsSnapshot;
  readonly onUpdatePlugin: (
    pluginId: string,
    input: PluginSettingsUpdateRequest
  ) => Promise<PluginSettingsSnapshot>;
}

const PluginSettingsCard: React.FC<PluginSettingsCardProps> = ({ snapshot, onUpdatePlugin }) => {
  const idPrefix = useId();
  const [draft, setDraft] = useState<PluginSettingsFormDraft>(() => createPluginSettingsDraft(snapshot));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<FormSubmitFeedback>({ kind: 'idle' });
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    setDraft(createPluginSettingsDraft(snapshot));
  }, [snapshot]);

  const dirty = useMemo(() => isPluginSettingsDraftDirty(snapshot, draft), [snapshot, draft]);
  const headingId = `${idPrefix}-heading`;

  const fieldElementId = (key: string): string => `${idPrefix}-field-${key}`;
  const fieldHelpId = (key: string): string => `${idPrefix}-help-${key}`;
  const fieldErrorId = (key: string): string => `${idPrefix}-err-${key}`;

  const handleFieldBlur = (field: PluginSettingField): void => {
    setDraft((prev) => {
      const err = validateSingleDraftField(prev, field);
      const nextErrors = { ...prev.fieldErrors };
      if (err) {
        nextErrors[field.key] = err;
      } else {
        delete nextErrors[field.key];
      }
      return { ...prev, fieldErrors: nextErrors };
    });
  };

  const focusFirstInvalidField = (fieldErrors: Readonly<Record<string, string>>): void => {
    const firstKey = Object.keys(fieldErrors)[0];
    if (!firstKey || !formRef.current) {
      return;
    }
    const target = formRef.current.querySelector<HTMLElement>(`[data-field-key="${CSS.escape(firstKey)}"]`);
    target?.focus();
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (saving) {
      return;
    }
    setFeedback({ kind: 'idle' });

    const prepared = buildPluginSettingsSubmitPayload(snapshot, draft);
    if (!prepared.ok) {
      setDraft((prev) => ({ ...prev, fieldErrors: prepared.fieldErrors }));
      setFeedback({
        kind: 'error',
        message: Object.values(prepared.fieldErrors)[0] ?? 'Please fix the highlighted setting errors.',
      });
      focusFirstInvalidField(prepared.fieldErrors);
      return;
    }

    setSaving(true);
    try {
      const updated = await onUpdatePlugin(snapshot.plugin_id, prepared.payload);
      setDraft(createPluginSettingsDraft(updated));
      setFeedback({ kind: 'success', message: 'Settings saved.' });
    } catch (err) {
      const serverFieldErrors = extractPluginSettingsApiFieldErrors(err);
      if (Object.keys(serverFieldErrors).length > 0) {
        setDraft((prev) => ({ ...prev, fieldErrors: serverFieldErrors }));
        focusFirstInvalidField(serverFieldErrors);
      }
      setFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = (): void => {
    setDraft(createPluginSettingsDraft(snapshot));
    setFeedback({ kind: 'idle' });
  };

  const renderInteractiveField = (field: PluginSettingField): React.ReactNode => {
    if (field.type === 'readonly') {
      return null;
    }

    const inputId = fieldElementId(field.key);
    const helpId = fieldHelpId(field.key);
    const errorId = fieldErrorId(field.key);
    const errorMsg = draft.fieldErrors[field.key];
    const hasError = Boolean(errorMsg);
    const describedByParts: string[] = [];
    if (field.helpText) {
      describedByParts.push(helpId);
    }
    if (hasError) {
      describedByParts.push(errorId);
    }
    const ariaDescribedBy = describedByParts.length > 0 ? describedByParts.join(' ') : undefined;

    if (isSecretPluginSettingField(field)) {
      const serverSecret = snapshot.secrets[field.key] ?? { configured: false, updated_at: null };
      const secretDraft = draft.secrets[field.key] ?? { kind: 'unchanged' };

      return (
        <div key={field.key} className={cx(styles, 'plugin-field')}>
          {secretDraft.kind === 'replacing' ? (
            <label htmlFor={inputId} className={cx(styles, 'plugin-field-label')}>
              {field.label}
              {field.required && (
                <span className={cx(styles, 'plugin-required-mark')} aria-hidden="true">
                  *
                </span>
              )}
            </label>
          ) : (
            <span className={cx(styles, 'plugin-field-label')}>
              {field.label}
              {field.required && (
                <span className={cx(styles, 'plugin-required-mark')} aria-hidden="true">
                  *
                </span>
              )}
            </span>
          )}
          <div className={cx(styles, 'plugin-secret-box')} data-secret-field={field.key}>
            <div className={cx(styles, 'plugin-secret-header')}>
              <span
                className={cx(
                  styles,
                  secretDraft.kind === 'cleared'
                    ? 'plugin-status-pill is-clearing'
                    : serverSecret.configured
                      ? 'plugin-status-pill is-configured'
                      : 'plugin-status-pill is-unconfigured'
                )}
              >
                {secretDraft.kind === 'cleared'
                  ? 'Pending Clear'
                  : serverSecret.configured
                    ? 'Configured'
                    : 'Not Configured'}
              </span>
              {serverSecret.configured && serverSecret.updated_at && secretDraft.kind === 'unchanged' && (
                <span className={cx(styles, 'plugin-card-meta')}>
                  Updated {formatArchivalTimestamp(serverSecret.updated_at, true)}
                </span>
              )}
            </div>

            {secretDraft.kind === 'unchanged' && (
              <>
                <span className={cx(styles, 'plugin-secret-mask')}>
                  {serverSecret.configured ? '•••••••••••• (write-only stored secret)' : 'No secret stored'}
                </span>
                <div className={cx(styles, 'plugin-secret-actions')}>
                  <button
                    type="button"
                    data-field-key={field.key}
                    className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                    onClick={() => {
                      setDraft((prev) =>
                        updateDraftSecretState(prev, field.key, {
                          kind: 'replacing',
                          value: '',
                          revealed: false,
                        })
                      );
                    }}
                  >
                    {serverSecret.configured ? `Replace ${field.label}` : `Set ${field.label}`}
                  </button>
                  {serverSecret.configured && !field.required && (
                    <button
                      type="button"
                      className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                      onClick={() => {
                        setDraft((prev) => updateDraftSecretState(prev, field.key, { kind: 'cleared' }));
                      }}
                    >
                      Clear {field.label}
                    </button>
                  )}
                </div>
              </>
            )}

            {secretDraft.kind === 'replacing' && (
              <div className={cx(styles, 'plugin-secret-input-row')}>
                <input
                  id={inputId}
                  name={field.key}
                  data-field-key={field.key}
                  type={secretDraft.revealed ? 'text' : 'password'}
                  className={cx(styles, 'plugin-input')}
                  value={secretDraft.value}
                  placeholder={field.placeholder ?? `Enter new ${field.label}`}
                  autoComplete="new-password"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={hasError ? 'true' : 'false'}
                  aria-describedby={ariaDescribedBy}
                  onChange={(e) => {
                    setDraft((prev) =>
                      updateDraftSecretState(prev, field.key, {
                        kind: 'replacing',
                        value: e.target.value,
                        revealed: secretDraft.revealed,
                      })
                    );
                  }}
                  onBlur={() => handleFieldBlur(field)}
                />
                <button
                  type="button"
                  aria-pressed={secretDraft.revealed}
                  className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                  onClick={() => {
                    setDraft((prev) =>
                      updateDraftSecretState(prev, field.key, {
                        kind: 'replacing',
                        value: secretDraft.value,
                        revealed: !secretDraft.revealed,
                      })
                    );
                  }}
                >
                  {secretDraft.revealed ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                  onClick={() => {
                    setDraft((prev) => updateDraftSecretState(prev, field.key, { kind: 'unchanged' }));
                  }}
                >
                  Cancel
                </button>
              </div>
            )}

            {secretDraft.kind === 'cleared' && (
              <div className={cx(styles, 'plugin-secret-actions')}>
                <span className={cx(styles, 'plugin-help-text')}>
                  Existing secret will be removed when you save.
                </span>
                <button
                  type="button"
                  data-field-key={field.key}
                  className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                  onClick={() => {
                    setDraft((prev) => updateDraftSecretState(prev, field.key, { kind: 'unchanged' }));
                  }}
                >
                  Keep Existing
                </button>
              </div>
            )}
          </div>
          {field.helpText && (
            <p id={helpId} className={cx(styles, 'plugin-help-text')}>
              {field.helpText}
            </p>
          )}
          {hasError && (
            <p id={errorId} className={cx(styles, 'plugin-field-error')}>
              {errorMsg}
            </p>
          )}
        </div>
      );
    }

    if (field.type === 'boolean') {
      const checked = draft.values[field.key] === true;
      return (
        <div key={field.key} className={cx(styles, 'plugin-field')}>
          <div className={cx(styles, 'plugin-toggle-row')}>
            <input
              id={inputId}
              name={field.key}
              data-field-key={field.key}
              type="checkbox"
              role="switch"
              aria-checked={checked}
              checked={checked}
              className={cx(styles, 'plugin-toggle-checkbox')}
              aria-invalid={hasError ? 'true' : 'false'}
              aria-describedby={ariaDescribedBy}
              onChange={(e) => {
                setDraft((prev) => updateDraftFieldValue(prev, field.key, e.target.checked));
              }}
            />
            <label htmlFor={inputId} className={cx(styles, 'plugin-toggle-label')}>
              {field.label}
            </label>
          </div>
          {field.helpText && (
            <p id={helpId} className={cx(styles, 'plugin-help-text')}>
              {field.helpText}
            </p>
          )}
          {hasError && (
            <p id={errorId} className={cx(styles, 'plugin-field-error')}>
              {errorMsg}
            </p>
          )}
        </div>
      );
    }

    if (field.type === 'select') {
      const currentVal = typeof draft.values[field.key] === 'string' ? String(draft.values[field.key]) : '';
      return (
        <div key={field.key} className={cx(styles, 'plugin-field')}>
          <label htmlFor={inputId} className={cx(styles, 'plugin-field-label')}>
            {field.label}
            {field.required && (
              <span className={cx(styles, 'plugin-required-mark')} aria-hidden="true">
                *
              </span>
            )}
          </label>
          <select
            id={inputId}
            name={field.key}
            data-field-key={field.key}
            className={cx(styles, 'plugin-select')}
            value={currentVal}
            required={field.required}
            aria-invalid={hasError ? 'true' : 'false'}
            aria-describedby={ariaDescribedBy}
            onChange={(e) => {
              setDraft((prev) => updateDraftFieldValue(prev, field.key, e.target.value));
            }}
            onBlur={() => handleFieldBlur(field)}
          >
            {field.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {field.helpText && (
            <p id={helpId} className={cx(styles, 'plugin-help-text')}>
              {field.helpText}
            </p>
          )}
          {hasError && (
            <p id={errorId} className={cx(styles, 'plugin-field-error')}>
              {errorMsg}
            </p>
          )}
        </div>
      );
    }

    if (field.type === 'number') {
      const rawVal = draft.values[field.key];
      const stringVal = typeof rawVal === 'number' && Number.isFinite(rawVal) ? String(rawVal) : '';
      return (
        <div key={field.key} className={cx(styles, 'plugin-field')}>
          <label htmlFor={inputId} className={cx(styles, 'plugin-field-label')}>
            {field.label}
            {field.required && (
              <span className={cx(styles, 'plugin-required-mark')} aria-hidden="true">
                *
              </span>
            )}
          </label>
          <input
            id={inputId}
            name={field.key}
            data-field-key={field.key}
            type="number"
            className={cx(styles, 'plugin-input')}
            value={stringVal}
            placeholder={field.placeholder}
            required={field.required}
            min={field.min}
            max={field.max}
            step={field.step ?? (field.integer ? 1 : 'any')}
            aria-invalid={hasError ? 'true' : 'false'}
            aria-describedby={ariaDescribedBy}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === '') {
                setDraft((prev) => updateDraftFieldValue(prev, field.key, null));
              } else {
                const num = Number(raw);
                setDraft((prev) => updateDraftFieldValue(prev, field.key, Number.isFinite(num) ? num : raw));
              }
            }}
            onBlur={() => handleFieldBlur(field)}
          />
          {field.helpText && (
            <p id={helpId} className={cx(styles, 'plugin-help-text')}>
              {field.helpText}
            </p>
          )}
          {hasError && (
            <p id={errorId} className={cx(styles, 'plugin-field-error')}>
              {errorMsg}
            </p>
          )}
        </div>
      );
    }

    // string | text | url
    const inputType = field.type === 'url' ? 'url' : 'text';
    const currentVal = typeof draft.values[field.key] === 'string' ? String(draft.values[field.key]) : '';

    return (
      <div key={field.key} className={cx(styles, 'plugin-field')}>
        <label htmlFor={inputId} className={cx(styles, 'plugin-field-label')}>
          {field.label}
          {field.required && (
            <span className={cx(styles, 'plugin-required-mark')} aria-hidden="true">
              *
            </span>
          )}
        </label>
        <input
          id={inputId}
          name={field.key}
          data-field-key={field.key}
          type={inputType}
          className={cx(styles, 'plugin-input')}
          value={currentVal}
          placeholder={field.placeholder}
          required={field.required}
          autoCorrect={field.type === 'url' ? 'off' : undefined}
          autoCapitalize={field.type === 'url' ? 'none' : undefined}
          spellCheck={field.type === 'url' ? false : undefined}
          aria-invalid={hasError ? 'true' : 'false'}
          aria-describedby={ariaDescribedBy}
          onChange={(e) => {
            setDraft((prev) => updateDraftFieldValue(prev, field.key, e.target.value));
          }}
          onBlur={() => handleFieldBlur(field)}
        />
        {field.helpText && (
          <p id={helpId} className={cx(styles, 'plugin-help-text')}>
            {field.helpText}
          </p>
        )}
        {hasError && (
          <p id={errorId} className={cx(styles, 'plugin-field-error')}>
            {errorMsg}
          </p>
        )}
      </div>
    );
  };

  const hasWritableFields = snapshot.schema.sections.some((section) =>
    section.fields.some((field) => field.type !== 'readonly')
  );

  return (
    <article className={cx(styles, 'plugin-card')} data-testid={`plugin-settings-card-${snapshot.plugin_id}`}>
      <div className={cx(styles, 'plugin-card-header')}>
        <div className={cx(styles, 'plugin-card-title-group')}>
          <h3 id={headingId} className={cx(styles, 'plugin-card-title')}>
            {snapshot.schema.title ?? snapshot.plugin_name}
          </h3>
          <div className={cx(styles, 'plugin-card-meta')}>
            <span>{snapshot.plugin_id}</span>
            <span>v{snapshot.plugin_version}</span>
            <span className={cx(styles, `plugin-status-pill is-${snapshot.status}`)}>{snapshot.status}</span>
            {dirty && <span className={cx(styles, 'plugin-status-pill is-dirty')}>Unsaved Changes</span>}
          </div>
          {snapshot.schema.description && (
            <p className={cx(styles, 'plugin-card-description')}>{snapshot.schema.description}</p>
          )}
        </div>
        {snapshot.updated_at && (
          <span className={cx(styles, 'plugin-card-meta')}>
            Last saved {formatArchivalTimestamp(snapshot.updated_at, true)}
          </span>
        )}
      </div>

      <form ref={formRef} aria-labelledby={headingId} noValidate onSubmit={(e) => void handleSubmit(e)}>
        {snapshot.schema.sections.map((section) => {
          const readonlyFields = section.fields.filter((f) => f.type === 'readonly');
          const interactiveFields = section.fields.filter((f) => f.type !== 'readonly');

          return (
            <fieldset key={section.id} className={cx(styles, 'plugin-fieldset')}>
              <legend className={cx(styles, 'plugin-legend')}>{section.title}</legend>
              {section.description && (
                <p className={cx(styles, 'plugin-section-desc')}>{section.description}</p>
              )}

              {readonlyFields.length > 0 && (
                <dl className={cx(styles, 'plugin-readonly-dl')}>
                  {readonlyFields.map((field) => (
                    <div key={field.key} className={cx(styles, 'plugin-readonly-item')}>
                      <dt>{field.label}</dt>
                      <dd>{formatReadonlySettingValue(snapshot.readonly_values[field.key])}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {interactiveFields.length > 0 && (
                <div className={cx(styles, 'plugin-fields-stack')}>
                  {interactiveFields.map((field) => renderInteractiveField(field))}
                </div>
              )}
            </fieldset>
          );
        })}

        {hasWritableFields && (
          <div className={cx(styles, 'plugin-form-footer')}>
            <div className={cx(styles, 'plugin-form-actions')}>
              <button
                type="submit"
                className={cx(wikiChromeStyles, 'wiki-btn-primary wiki-btn-sm')}
                disabled={saving}
              >
                {saving ? 'Saving…' : `Save ${snapshot.plugin_name} Settings`}
              </button>
              {dirty && (
                <button
                  type="button"
                  className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                  disabled={saving}
                  onClick={handleReset}
                >
                  Reset Changes
                </button>
              )}
            </div>
            <span
              role="status"
              aria-live="polite"
              className={cx(
                styles,
                feedback.kind === 'success'
                  ? 'plugin-feedback-status is-success'
                  : feedback.kind === 'error'
                    ? 'plugin-feedback-status is-error'
                    : 'plugin-feedback-status'
              )}
            >
              {feedback.kind === 'idle' ? '' : feedback.message}
            </span>
          </div>
        )}
      </form>
    </article>
  );
};

export const PluginSettingsSection: React.FC<PluginSettingsSectionProps> = ({
  plugins,
  loading,
  error,
  supported,
  onRefresh,
  onUpdatePlugin,
}) => (
  <section
    className={cx(layoutStyles, 'place-map-box')}
    aria-labelledby="admin-plugin-settings-heading"
    data-testid="admin-plugin-settings"
  >
    <div className={cx(styles, 'plugin-settings-header')}>
      <div className={cx(styles, 'plugin-settings-header-copy')}>
        <h2 id="admin-plugin-settings-heading" className={cx(wikiPanelStyles, 'wiki-section-title')}>
          Plugins &amp; Integrations
        </h2>
        <p className={cx(styles, 'plugin-settings-subtitle')}>
          Configure registered Kinloom plugins from their declarative schemas. Secret fields are write-only,
          masked in the browser, and preserved untouched when you update unrelated settings.
        </p>
      </div>
      {supported && (
        <button
          type="button"
          className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
          disabled={loading}
          onClick={() => {
            void onRefresh();
          }}
        >
          {loading ? 'Refreshing…' : 'Refresh Plugins'}
        </button>
      )}
    </div>

    {!supported && (
      <p className={cx(controlStyles, 'empty-ring-note')}>
        Plugin settings endpoint is not provided by the active admin data source.
      </p>
    )}

    {error && (
      <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
        <p>Could not load plugin settings: {error}</p>
      </div>
    )}

    {supported && loading && plugins.length === 0 && (
      <p className={cx(controlStyles, 'empty-ring-note')}>Loading plugin settings…</p>
    )}

    {supported && !loading && !error && plugins.length === 0 && (
      <p className={cx(controlStyles, 'empty-ring-note')}>
        No registered server plugins declare configurable settings.
      </p>
    )}

    {plugins.length > 0 && (
      <div className={cx(styles, 'plugin-settings-list')}>
        {plugins.map((snapshot) => (
          <PluginSettingsCard key={snapshot.plugin_id} snapshot={snapshot} onUpdatePlugin={onUpdatePlugin} />
        ))}
      </div>
    )}
  </section>
);
