import type React from 'react';
import canvasSurfaceStyles from '../../components/CanvasSurfacePrimitives.module.css';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import treePageStyles from '../TreePage.module.css';

export interface TreeZoomControlsProps {
  readonly controlsRef?: React.RefObject<HTMLDivElement | null>;
  readonly zoomPercent: number;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
  readonly onResetZoom: () => void;
  readonly loomActive?: boolean;
  readonly onToggleLoom?: () => void;
}

export const TreeZoomControls: React.FC<TreeZoomControlsProps> = ({
  controlsRef,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFit,
  onResetZoom,
  loomActive = false,
  onToggleLoom,
}) => (
  <div
    ref={controlsRef}
    className={cx(canvasSurfaceStyles, 'tree-controls')}
    role="group"
    aria-label={KINLOOM_VOCABULARY.tree.zoomControlsAria}
  >
    <button
      type="button"
      className={cx(controlStyles, 'pill-btn')}
      aria-label="Zoom in"
      title="Zoom in (+)"
      onClick={onZoomIn}
    >
      +
    </button>
    <button
      type="button"
      className={cx(controlStyles, 'pill-btn')}
      aria-label="Zoom out"
      title="Zoom out (-)"
      onClick={onZoomOut}
    >
      −
    </button>
    <button
      type="button"
      className={cx(controlStyles, 'pill-btn')}
      title="Fit full chart (0)"
      onClick={onFit}
    >
      Fit
    </button>
    <button
      type="button"
      className={cx(controlStyles, 'pill-btn')}
      aria-label="Reset zoom to 100%"
      title="Reset zoom to 100% (1)"
      onClick={onResetZoom}
    >
      1:1
    </button>
    {onToggleLoom && (
      <button
        type="button"
        className={cx(controlStyles, `pill-btn${loomActive ? ' active' : ''}`)}
        aria-pressed={loomActive}
        title="Toggle Kinship Loom birth-year constellation (< 45% zoom tier)"
        onClick={onToggleLoom}
      >
        Loom
      </button>
    )}
    <output
      className={cx(treePageStyles, 'tree-zoom-readout')}
      aria-live="polite"
      aria-label={`Zoom ${zoomPercent}%`}
    >
      {zoomPercent}%
    </output>
  </div>
);
