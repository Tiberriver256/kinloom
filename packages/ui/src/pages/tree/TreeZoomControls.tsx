import type React from 'react';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';

export interface TreeZoomControlsProps {
  readonly zoomPercent: number;
  readonly uiStyles: Readonly<Record<string, string>>;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
  readonly onResetZoom: () => void;
}

export const TreeZoomControls: React.FC<TreeZoomControlsProps> = ({
  zoomPercent,
  uiStyles,
  onZoomIn,
  onZoomOut,
  onFit,
  onResetZoom,
}) => (
  <div
    className={cx(uiStyles, 'tree-controls')}
    role="group"
    aria-label={KINLOOM_VOCABULARY.tree.zoomControlsAria}
  >
    <button
      type="button"
      className={cx(uiStyles, 'pill-btn')}
      aria-label="Zoom in"
      title="Zoom in (+)"
      onClick={onZoomIn}
    >
      +
    </button>
    <button
      type="button"
      className={cx(uiStyles, 'pill-btn')}
      aria-label="Zoom out"
      title="Zoom out (-)"
      onClick={onZoomOut}
    >
      −
    </button>
    <button type="button" className={cx(uiStyles, 'pill-btn')} title="Fit full chart (0)" onClick={onFit}>
      Fit
    </button>
    <button
      type="button"
      className={cx(uiStyles, 'pill-btn')}
      aria-label="Reset zoom to 100%"
      title="Reset zoom to 100% (1)"
      onClick={onResetZoom}
    >
      1:1
    </button>
    <output
      className={cx(uiStyles, 'tree-zoom-readout')}
      aria-live="polite"
      aria-label={`Zoom ${zoomPercent}%`}
    >
      {zoomPercent}%
    </output>
  </div>
);
