import type { EntityDiffSummary, EntityPayload, FieldDiff, Person, SourceRecord } from '@kinloom/core';
import { computeEntityDiff } from '@kinloom/core';
import type React from 'react';
import { useMemo, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { formatFieldLabel, formatRevisionDiffValue } from '../../lib/revisionFieldFormat.js';
import wikiPanelStyles from './WikiPanels.module.css';

export interface RevisionDiffViewProps {
  before?: EntityPayload | null | undefined;
  after?: EntityPayload | null | undefined;
  diff?: EntityDiffSummary | undefined;
  beforeLabel?: string | undefined;
  afterLabel?: string | undefined;
  compact?: boolean | undefined;
  peopleById?: ReadonlyMap<string, Person> | undefined;
  sourcesById?: ReadonlyMap<string, SourceRecord> | undefined;
}

function symbolForKind(kind: FieldDiff['kind']): { glyph: string; label: string } {
  if (kind === 'added') {
    return { glyph: '+', label: 'Added' };
  }
  if (kind === 'removed') {
    return { glyph: '−', label: 'Removed' };
  }
  return { glyph: '~', label: 'Changed' };
}

/**
 * Side-by-side visual field diff table using WCAG AAA/AA `--diff-add-*` and `--diff-del-*` tokens
 * with non-color prefix glyphs (`+`, `−`, `~`), human-readable field labels, and a Raw JSON toggle.
 */
export const RevisionDiffView: React.FC<RevisionDiffViewProps> = ({
  before = null,
  after = null,
  diff: providedDiff,
  beforeLabel = 'Before',
  afterLabel = 'After',
  compact = false,
  peopleById,
  sourcesById,
}) => {
  const [mode, setMode] = useState<'readable' | 'raw'>('readable');
  const summary = useMemo(
    () => providedDiff ?? computeEntityDiff(before, after),
    [providedDiff, before, after]
  );

  if (!summary.hasChanges || summary.fields.length === 0) {
    return (
      <div className={cx(wikiPanelStyles, 'wiki-diff-empty')}>
        No field differences between {beforeLabel.toLowerCase()} and {afterLabel.toLowerCase()}.
      </div>
    );
  }

  return (
    <div className={cx(wikiPanelStyles, `wiki-diff-wrap${compact ? ' is-compact' : ''}`)}>
      <div className={cx(wikiPanelStyles, 'wiki-diff-summary-bar')}>
        <div className={cx(wikiPanelStyles, 'wiki-diff-stats')}>
          <span className={cx(wikiPanelStyles, 'wiki-diff-stat wiki-diff-stat-add')}>
            +{summary.addedCount} added
          </span>
          <span className={cx(wikiPanelStyles, 'wiki-diff-stat wiki-diff-stat-del')}>
            −{summary.removedCount} removed
          </span>
          <span className={cx(wikiPanelStyles, 'wiki-diff-stat wiki-diff-stat-chg')}>
            ~{summary.changedCount} changed
          </span>
        </div>
        <button
          type="button"
          className={cx(wikiPanelStyles, 'wiki-diff-mode-btn')}
          aria-pressed={mode === 'raw'}
          onClick={() => {
            setMode((prev) => (prev === 'readable' ? 'raw' : 'readable'));
          }}
        >
          {mode === 'raw' ? 'Readable diff' : 'Raw JSON'}
        </button>
      </div>

      <div
        className={cx(wikiPanelStyles, 'wiki-diff-table-region')}
        role="region"
        aria-label="Field differences"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: horizontally scrollable region needs keyboard focus
        tabIndex={0}
      >
        <table className={cx(wikiPanelStyles, 'wiki-diff-table')}>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">{beforeLabel}</th>
              <th scope="col">{afterLabel}</th>
            </tr>
          </thead>
          <tbody>
            {summary.fields.map((field) => {
              const sym = symbolForKind(field.kind);
              const beforeText = formatRevisionDiffValue(field.path, field.before, mode, {
                peopleById,
                sourcesById,
              });
              const afterText = formatRevisionDiffValue(field.path, field.after, mode, {
                peopleById,
                sourcesById,
              });
              return (
                <tr key={field.path} className={`wiki-diff-row kind-${field.kind}`}>
                  <th scope="row" className={cx(wikiPanelStyles, 'wiki-diff-field-cell')}>
                    <span
                      className={cx(wikiPanelStyles, 'wiki-diff-glyph')}
                      role="img"
                      aria-label={sym.label}
                    >
                      {sym.glyph}
                    </span>
                    {mode === 'raw' ? (
                      <code className={cx(wikiPanelStyles, 'wiki-diff-raw-key')}>{field.path}</code>
                    ) : (
                      <span>{formatFieldLabel(field.path)}</span>
                    )}
                  </th>
                  <td
                    data-label={beforeLabel}
                    className={cx(
                      wikiPanelStyles,
                      field.kind === 'added' ? 'wiki-diff-cell-empty' : 'wiki-diff-cell-del'
                    )}
                  >
                    {field.kind !== 'added' && (
                      <span className={'wiki-diff-prefix'} aria-hidden="true">
                        −{' '}
                      </span>
                    )}
                    <span className={cx(wikiPanelStyles, 'wiki-diff-value')}>{beforeText}</span>
                  </td>
                  <td
                    data-label={afterLabel}
                    className={cx(
                      wikiPanelStyles,
                      field.kind === 'removed' ? 'wiki-diff-cell-empty' : 'wiki-diff-cell-add'
                    )}
                  >
                    {field.kind !== 'removed' && (
                      <span className={'wiki-diff-prefix'} aria-hidden="true">
                        +{' '}
                      </span>
                    )}
                    <span className={cx(wikiPanelStyles, 'wiki-diff-value')}>{afterText}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
