import type { Person } from '@kinloom/core';
import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { formatCardLifespan } from '../../lib/archivalTreeModel.js';
import { cx, joinClasses } from '../../lib/cx.js';
import {
  computeKinshipLoomLabelPlacements,
  computeKinshipLoomLayout,
  computeKinshipLoomSpotlight,
} from '../../lib/tree/kinshipLoomModel.js';
import type { ArchivalTreeModel } from '../../lib/tree/types.js';
import controlStyles from '../../styles/Controls.module.css';
import loomStyles from './TreeKinshipLoom.module.css';

type LoomZoomMode = 'auto' | 'fit' | 'custom';

const LOOM_MIN_ZOOM = 0.4;
const LOOM_MAX_ZOOM = 2.4;
const LOOM_ZOOM_STEP = 1.25;

function getInitialLoomZoomMode(): LoomZoomMode {
  return typeof window !== 'undefined' && window.innerWidth <= 768 ? 'fit' : 'auto';
}

export interface TreeKinshipLoomProps {
  readonly model: ArchivalTreeModel;
  readonly selectedPersonId: string | null;
  readonly familyLabel: string;
  readonly onSelectPerson: (person: Person, fromKeyboard: boolean) => void;
  readonly onReturnToChart?: () => void;
  readonly onSwitchToRoll?: () => void;
}

export const TreeKinshipLoom: React.FC<TreeKinshipLoomProps> = ({
  model,
  selectedPersonId,
  familyLabel,
  onSelectPerson,
}) => {
  const [hoveredPersonId, setHoveredPersonId] = useState<string | null>(null);
  const [focusedPersonId, setFocusedPersonId] = useState<string | null>(null);
  const [zoomMode, setZoomMode] = useState<LoomZoomMode>(getInitialLoomZoomMode);
  const [zoomScale, setZoomScale] = useState<number>(1);
  const nodeRefs = useRef<Array<SVGGElement | null>>([]);

  const layout = useMemo(() => computeKinshipLoomLayout({ model }), [model]);
  const activeTraceId = focusedPersonId ?? hoveredPersonId ?? selectedPersonId;

  const spotlight = useMemo(() => computeKinshipLoomSpotlight(model, activeTraceId), [model, activeTraceId]);

  const activeTracePerson = useMemo(
    () => (activeTraceId ? (layout.nodes.find((n) => n.person.id === activeTraceId)?.person ?? null) : null),
    [layout.nodes, activeTraceId]
  );

  const focalPersonId = useMemo(() => {
    if (activeTraceId) {
      return activeTraceId;
    }
    const anchorNode = layout.nodes.find((n) => n.isAnchor);
    if (anchorNode) {
      return anchorNode.person.id;
    }
    if (model.pivotPersonId && layout.nodes.some((n) => n.person.id === model.pivotPersonId)) {
      return model.pivotPersonId;
    }
    return layout.nodes[0]?.person.id ?? null;
  }, [activeTraceId, layout.nodes, model.pivotPersonId]);

  const visibleLabelIds = useMemo(() => {
    const ids = new Set<string>();
    const showAll = layout.nodes.length <= 24;
    for (const node of layout.nodes) {
      const pid = node.person.id;
      const isLit = Boolean(spotlight?.highlightedPersonIds.has(pid));
      const isFocus = activeTraceId === pid;
      const isRestingFocal = focalPersonId === pid;
      if (isFocus || isLit || isRestingFocal || showAll) {
        ids.add(pid);
      }
    }
    return ids;
  }, [layout.nodes, spotlight, activeTraceId, focalPersonId]);

  const labelPlacements = useMemo(
    () =>
      computeKinshipLoomLabelPlacements({
        nodes: layout.nodes,
        visiblePersonIds: visibleLabelIds,
        width: layout.width,
        height: layout.height,
        priorityPersonId: focalPersonId,
      }),
    [layout.nodes, visibleLabelIds, layout.width, layout.height, focalPersonId]
  );

  const handleNodeKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGGElement>, index: number, person: Person) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectPerson(person, true);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = (index + 1) % layout.nodes.length;
        nodeRefs.current[nextIdx]?.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = (index - 1 + layout.nodes.length) % layout.nodes.length;
        nodeRefs.current[prevIdx]?.focus();
      } else if (e.key === 'Escape') {
        setHoveredPersonId(null);
        setFocusedPersonId(null);
      }
    },
    [layout.nodes.length, onSelectPerson]
  );

  const handleZoomIn = useCallback(() => {
    setZoomMode('custom');
    setZoomScale((prev) => Math.min(LOOM_MAX_ZOOM, Math.round(prev * LOOM_ZOOM_STEP * 100) / 100));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomMode('custom');
    setZoomScale((prev) => Math.max(LOOM_MIN_ZOOM, Math.round((prev / LOOM_ZOOM_STEP) * 100) / 100));
  }, []);

  const handleToggleFit = useCallback(() => {
    setZoomMode((cur) => {
      if (cur === 'fit') {
        setZoomScale(1);
        return 'auto';
      }
      setZoomScale(1);
      return 'fit';
    });
  }, []);

  const hasSpotlight = spotlight !== null;
  const isFitMode = zoomMode === 'fit';
  const svgStyle: React.CSSProperties | undefined = isFitMode
    ? undefined
    : {
        width: `${Math.round(layout.width * zoomScale)}px`,
        height: `${Math.round(layout.height * zoomScale)}px`,
      };
  const zoomBtnClass = joinClasses(cx(controlStyles, 'pill-btn'), cx(loomStyles, 'kinship-loom-zoom-btn'));

  return (
    <section
      className={cx(loomStyles, 'kinship-loom-shell')}
      aria-label={`${familyLabel} Kinship Loom birth-year constellation`}
      data-zoom-mode={zoomMode}
      data-zoom-scale={String(zoomScale)}
    >
      <div className={cx(loomStyles, 'kinship-loom-bar')}>
        <div className={cx(loomStyles, 'kinship-loom-meta')}>
          <span className={cx(loomStyles, 'kinship-loom-title')}>Kinship Loom</span>
          <span className={cx(loomStyles, 'kinship-loom-span')}>
            {layout.minYear}–{layout.maxYear} · {layout.nodes.length}{' '}
            {layout.nodes.length === 1 ? 'person' : 'people'}
          </span>
          {activeTracePerson && spotlight ? (
            <span className={cx(loomStyles, 'kinship-loom-trace')}>
              Trace My Thread: <strong>{activeTracePerson.full_name}</strong> (
              {formatCardLifespan(activeTracePerson)}){' · '}
              {spotlight.ancestorCount} {spotlight.ancestorCount === 1 ? 'ancestor' : 'ancestors'},{' '}
              {spotlight.descendantCount} {spotlight.descendantCount === 1 ? 'descendant' : 'descendants'}
            </span>
          ) : (
            <span className={cx(loomStyles, 'kinship-loom-hint')}>
              Select any person to trace their thread
            </span>
          )}
        </div>
      </div>

      <div className={cx(loomStyles, 'kinship-loom-viewport')}>
        <div className={cx(loomStyles, 'kinship-loom-canvas-wrap')}>
          <svg
            className={cx(
              loomStyles,
              `kinship-loom-svg${hasSpotlight ? ' has-spotlight' : ''}${isFitMode ? ' is-fit' : ''}`
            )}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={svgStyle}
            role="group"
            aria-label={`${familyLabel} birth-year river constellation (${layout.minYear}–${layout.maxYear})`}
          >
            <g className={cx(loomStyles, 'kinship-loom-axis')}>
              {layout.decadeTicks.map((tick) => (
                <g key={tick.year} transform={`translate(0, ${tick.y})`}>
                  <line
                    x1={64}
                    y1={0}
                    x2={layout.width - 24}
                    y2={0}
                    className={cx(loomStyles, 'kinship-loom-gridline')}
                  />
                  <text x={56} y={4} textAnchor="end" className={cx(loomStyles, 'kinship-loom-year-label')}>
                    {tick.year}
                  </text>
                </g>
              ))}
            </g>

            <g className={cx(loomStyles, 'kinship-loom-threads')}>
              {layout.threads.map((thread) => {
                const isLit = Boolean(
                  spotlight?.highlightedPersonIds.has(thread.fromPersonId) &&
                    spotlight.highlightedPersonIds.has(thread.toPersonId)
                );
                return (
                  <path
                    key={thread.id}
                    d={thread.path}
                    data-lit={isLit ? 'true' : 'false'}
                    className={cx(
                      loomStyles,
                      `kinship-loom-thread kind-${thread.kind}${thread.isCrossBranch ? ' is-cross-branch' : ''}${isLit ? ' is-lit' : ''}`
                    )}
                  />
                );
              })}
            </g>

            <g className={cx(loomStyles, 'kinship-loom-nodes')}>
              {layout.nodes.map((node, idx) => {
                const pid = node.person.id;
                const isLit = Boolean(spotlight?.highlightedPersonIds.has(pid));
                const isFocus = activeTraceId === pid;
                const lifespan = formatCardLifespan(node.person);
                const placement = labelPlacements.get(pid);
                const relX = placement ? Math.round((placement.x - node.x) * 10) / 10 : 10;
                const relY = placement ? Math.round((placement.y - node.y) * 10) / 10 : 0;
                const relBoxX = placement ? Math.round((placement.boxX - node.x) * 10) / 10 : 7;
                const relBoxY = placement ? Math.round((placement.boxY - node.y) * 10) / 10 : -8;

                return (
                  <g
                    key={pid}
                    ref={(el) => {
                      nodeRefs.current[idx] = el;
                    }}
                    transform={`translate(${node.x}, ${node.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.person.full_name} (${lifespan})`}
                    aria-pressed={selectedPersonId === pid}
                    data-person-id={pid}
                    data-lit={isLit ? 'true' : 'false'}
                    className={cx(
                      loomStyles,
                      `kinship-loom-node${isLit ? ' is-lit' : ''}${isFocus ? ' is-focus' : ''}${node.isAnchor ? ' is-anchor' : ''}`
                    )}
                    onMouseEnter={() => {
                      setHoveredPersonId(pid);
                    }}
                    onMouseLeave={() => {
                      setHoveredPersonId((cur) => (cur === pid ? null : cur));
                    }}
                    onFocus={() => {
                      setFocusedPersonId(pid);
                    }}
                    onBlur={() => {
                      setFocusedPersonId((cur) => (cur === pid ? null : cur));
                    }}
                    onClick={() => {
                      onSelectPerson(node.person, false);
                    }}
                    onKeyDown={(e) => {
                      handleNodeKeyDown(e, idx, node.person);
                    }}
                  >
                    <circle r={14} className={cx(loomStyles, 'kinship-loom-hit-target')} />
                    <circle
                      r={isFocus ? 7 : node.isAnchor ? 6.5 : 5}
                      className={cx(loomStyles, 'kinship-loom-dot')}
                    />
                    {placement && (
                      <>
                        {placement.hasLeader && (
                          <line
                            x1={0}
                            y1={0}
                            x2={relX}
                            y2={relY}
                            className={cx(loomStyles, 'kinship-loom-label-leader')}
                          />
                        )}
                        <rect
                          x={relBoxX}
                          y={relBoxY}
                          width={placement.width}
                          height={placement.height}
                          rx={3}
                          className={cx(loomStyles, 'kinship-loom-label-bg')}
                        />
                        <text
                          x={relX}
                          y={relY + 4}
                          textAnchor={placement.textAnchor}
                          data-label-y={placement.y}
                          className={cx(loomStyles, 'kinship-loom-node-label')}
                        >
                          {node.person.full_name}
                        </text>
                      </>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        <div
          className={cx(loomStyles, 'kinship-loom-zoom-controls')}
          role="group"
          aria-label="Kinship Loom zoom controls"
        >
          <button
            type="button"
            className={zoomBtnClass}
            aria-label="Zoom in Kinship Loom"
            title="Zoom in"
            onClick={handleZoomIn}
          >
            +
          </button>
          <button
            type="button"
            className={zoomBtnClass}
            aria-label="Zoom out Kinship Loom"
            title="Zoom out"
            onClick={handleZoomOut}
          >
            −
          </button>
          <button
            type="button"
            className={joinClasses(
              cx(controlStyles, `pill-btn${isFitMode ? ' active' : ''}`),
              cx(loomStyles, 'kinship-loom-zoom-btn')
            )}
            aria-pressed={isFitMode}
            title={isFitMode ? 'Return to 1:1 readable scale' : 'Fit full river to viewport'}
            onClick={handleToggleFit}
          >
            Fit
          </button>
        </div>
      </div>
    </section>
  );
};
