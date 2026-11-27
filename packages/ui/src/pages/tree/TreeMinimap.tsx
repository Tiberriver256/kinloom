import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ArchivalDiagramLayout, LineageSpotlight } from '../../lib/archivalTreeModel.js';
import { MOBILE_TREE_BREAKPOINT_PX } from '../../lib/archivalTreeModel.js';
import { cx } from '../../lib/cx.js';
import controlStyles from '../../styles/Controls.module.css';
import treePageStyles from '../TreePage.module.css';
import type { ViewportSnapshot } from './useTreeViewportTransform.js';

export interface TreeMinimapProps {
  readonly layout: ArchivalDiagramLayout;
  readonly spotlight: LineageSpotlight | null;
  readonly selectedPersonId: string | null;
  readonly getViewportSnapshot: () => ViewportSnapshot;
  readonly subscribeTransform: (listener: (snapshot: ViewportSnapshot) => void) => () => void;
  readonly onNavigateToPoint: (graphX: number, graphY: number) => void;
  readonly onPanBy: (dx: number, dy: number) => void;
  readonly onFit: () => void;
}

export const TreeMinimap: React.FC<TreeMinimapProps> = ({
  layout,
  spotlight,
  selectedPersonId,
  getViewportSnapshot,
  subscribeTransform,
  onNavigateToPoint,
  onPanBy,
  onFit,
}) => {
  const [expanded, setExpanded] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= MOBILE_TREE_BREAKPOINT_PX
  );
  const [snapshot, setSnapshot] = useState<ViewportSnapshot>(() => getViewportSnapshot());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingPointerIdRef = useRef<number | null>(null);
  const panelId = useId();

  useEffect(() => {
    setSnapshot(getViewportSnapshot());
    return subscribeTransform((next) => {
      setSnapshot(next);
    });
  }, [getViewportSnapshot, subscribeTransform]);

  const { bounds } = layout;
  const graphW = Math.max(1, bounds.maxX - bounds.minX);
  const graphH = Math.max(1, bounds.maxY - bounds.minY);
  const svgHeight = Math.max(68, Math.min(132, Math.round((180 * graphH) / graphW)));

  const navigateFromClientPoint = useCallback(
    (clientX: number, clientY: number): void => {
      const svg = svgRef.current;
      if (!svg) {
        return;
      }
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const normX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const normY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      onNavigateToPoint(bounds.minX + normX * graphW, bounds.minY + normY * graphH);
    },
    [bounds.minX, bounds.minY, graphH, graphW, onNavigateToPoint]
  );

  const safeZoom = Math.max(0.05, snapshot.zoom);
  const rawViewX = -snapshot.pan.x / safeZoom;
  const rawViewY = -snapshot.pan.y / safeZoom;
  const rawViewW = snapshot.viewportWidth / safeZoom;
  const rawViewH = snapshot.viewportHeight / safeZoom;

  const clampedX1 = Math.max(bounds.minX, Math.min(bounds.maxX, rawViewX));
  const clampedY1 = Math.max(bounds.minY, Math.min(bounds.maxY, rawViewY));
  const clampedX2 = Math.max(clampedX1, Math.min(bounds.maxX, rawViewX + rawViewW));
  const clampedY2 = Math.max(clampedY1, Math.min(bounds.maxY, rawViewY + rawViewH));
  const minRectW = Math.max(24, graphW * 0.04);
  const minRectH = Math.max(20, graphH * 0.04);
  const viewRectW = Math.max(minRectW, clampedX2 - clampedX1);
  const viewRectH = Math.max(minRectH, clampedY2 - clampedY1);
  const viewRectX = Math.min(clampedX1, Math.max(bounds.minX, bounds.maxX - viewRectW));
  const viewRectY = Math.min(clampedY1, Math.max(bounds.minY, bounds.maxY - viewRectH));

  const highlightedIds = spotlight?.highlightedPersonIds ?? null;

  return (
    <aside
      className={cx(treePageStyles, `tree-minimap${expanded ? ' is-expanded' : ' is-collapsed'}`)}
      aria-label="Tree overview minimap"
    >
      <div className={cx(treePageStyles, 'tree-minimap-header')}>
        <span className={cx(treePageStyles, 'tree-minimap-title')}>Overview</span>
        <button
          type="button"
          className={cx(controlStyles, 'pill-btn tree-minimap-toggle')}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={expanded ? 'Collapse overview minimap' : 'Expand overview minimap'}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((prev) => !prev);
          }}
        >
          {expanded ? 'Hide' : 'Map'}
        </button>
      </div>

      {expanded && (
        <button
          type="button"
          id={panelId}
          className={cx(treePageStyles, 'tree-minimap-surface')}
          aria-label="Interactive tree minimap. Click or drag to pan, or use arrow keys to move viewport and Home to fit."
          onKeyDown={(e) => {
            const stepX = Math.max(80, Math.round(snapshot.viewportWidth * 0.16));
            const stepY = Math.max(60, Math.round(snapshot.viewportHeight * 0.16));
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              e.stopPropagation();
              onPanBy(stepX, 0);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              e.stopPropagation();
              onPanBy(-stepX, 0);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              onPanBy(0, stepY);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              e.stopPropagation();
              onPanBy(0, -stepY);
            } else if (e.key === 'Home' || e.key === '0') {
              e.preventDefault();
              e.stopPropagation();
              onFit();
            }
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            draggingPointerIdRef.current = e.pointerId;
            if (typeof e.currentTarget.setPointerCapture === 'function') {
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                // Ignore synthetic events without an active pointer capture target.
              }
            }
            navigateFromClientPoint(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => {
            if (draggingPointerIdRef.current !== e.pointerId) {
              return;
            }
            e.stopPropagation();
            navigateFromClientPoint(e.clientX, e.clientY);
          }}
          onPointerUp={(e) => {
            if (draggingPointerIdRef.current === e.pointerId) {
              e.stopPropagation();
              draggingPointerIdRef.current = null;
            }
          }}
          onPointerCancel={(e) => {
            if (draggingPointerIdRef.current === e.pointerId) {
              draggingPointerIdRef.current = null;
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <svg
            ref={svgRef}
            className={cx(treePageStyles, 'tree-minimap-svg')}
            width="100%"
            height={svgHeight}
            viewBox={`${bounds.minX} ${bounds.minY} ${graphW} ${graphH}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {layout.genBands.map((band) => (
              <line
                key={band.gen}
                x1={bounds.minX + 16}
                y1={band.y + 26}
                x2={bounds.maxX - 16}
                y2={band.y + 26}
                stroke="var(--border-decorative)"
                strokeWidth={Math.max(4, graphH * 0.004)}
                opacity="0.6"
              />
            ))}
            {layout.nodes.map((node) => {
              const isSelected = selectedPersonId === node.person.id;
              const isLit = Boolean(highlightedIds?.has(node.person.id));
              const fill =
                isSelected || isLit
                  ? 'var(--accent-primary)'
                  : node.isDirect
                    ? 'var(--surface-header)'
                    : 'var(--border-control)';
              return (
                <rect
                  key={node.person.id}
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx={4}
                  fill={fill}
                  opacity={highlightedIds && !isLit ? 0.3 : 0.9}
                />
              );
            })}
            <rect
              className={cx(treePageStyles, 'tree-minimap-viewport')}
              x={viewRectX}
              y={viewRectY}
              width={viewRectW}
              height={viewRectH}
              fill="var(--accent-primary)"
              fillOpacity="0.14"
              stroke="var(--accent-primary)"
              strokeWidth={Math.max(8, Math.max(graphW, graphH) * 0.008)}
            />
          </svg>
        </button>
      )}
    </aside>
  );
};
