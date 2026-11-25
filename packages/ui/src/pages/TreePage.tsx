import type { CoupleLink, GenBand, Person, PlacedNode, TreeBounds } from '@kinloom/core';
import {
  TREE_NODE_H as NODE_H,
  TREE_NODE_W as NODE_W,
  buildPersonThumbMap,
  computeTreeLayout,
  emptyTreeLayout,
  resolveDefaultBranchId,
} from '@kinloom/core';
import type { CanvasTransform, Point2D } from '../lib/treeGestures.js';
import {
  clampPan,
  computeDoubleTapZoom,
  computePinchTransform,
  computeWheelTargetZoom,
  computeZoomAroundPoint,
  distanceBetween,
  isDragMovement,
  midpointBetween,
  stepInertia,
} from '../lib/treeGestures.js';
import { Link, useSearchParams } from 'react-router-dom';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { initialsOf, resolveAssetUrl } from '../components/Atoms.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';

const INITIAL_TRANSFORM: CanvasTransform = {
  pan: { x: 40, y: 40 },
  zoom: 0.75,
};

interface PreparedEdge {
  key: string;
  d: string;
  childId: string;
  parentIds: string[];
  isDirect: boolean;
}

interface PreparedNode {
  node: PlacedNode;
  displayName: string;
  lifespanPlace: string;
  thumbUrl: string | null;
  initials: string;
}

const TreeGenBandsImpl: React.FC<{ genBands: GenBand[]; maxX: number }> = ({
  genBands,
  maxX,
}) => (
  <g>
    {genBands.map((b) => (
      <g key={b.gen}>
        <line
          x1={16}
          y1={b.y + NODE_H / 2}
          x2={maxX - 16}
          y2={b.y + NODE_H / 2}
          stroke="#D6CEBE"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
        <rect
          x={12}
          y={b.y + 10}
          width={110}
          height={28}
          rx={3}
          fill="#FCF9F2"
          stroke="#827A6A"
        />
        <text
          x={67}
          y={b.y + 28}
          textAnchor="middle"
          fontSize="10"
          fontWeight="600"
          fontFamily="IBM Plex Mono, monospace"
          fill="#4E4A42"
        >
          G{b.gen + 1} · {b.yearRange}
        </text>
      </g>
    ))}
  </g>
);
const TreeGenBands = React.memo(TreeGenBandsImpl);

const TreeEdgeItemImpl: React.FC<{ d: string; isDirect: boolean; isLit: boolean }> = ({
  d,
  isDirect,
  isLit,
}) => {
  const cls = `tree-edge${isDirect ? ' is-direct' : ''}${isLit ? ' is-lit' : ''}`;
  return (
    <path
      className={cls}
      d={d}
      fill="none"
      stroke={isDirect ? '#1B2A41' : '#827A6A'}
      strokeWidth={isDirect ? 2.1 : 1.15}
    />
  );
};
const TreeEdgeItem = React.memo(TreeEdgeItemImpl);

const TreeCoupleItemImpl: React.FC<{ couple: CoupleLink; isLit: boolean }> = ({
  couple,
  isLit,
}) => (
  <g className={`tree-couple${isLit ? ' is-lit' : ''}`}>
    <line
      x1={couple.a.x + NODE_W}
      y1={couple.midY}
      x2={couple.b.x}
      y2={couple.midY}
      stroke="#7A4612"
      strokeWidth="2.2"
    />
    <line
      x1={couple.midX}
      y1={couple.midY}
      x2={couple.midX}
      y2={couple.a.y + NODE_H}
      stroke="#7A4612"
      strokeWidth="1.6"
    />
  </g>
);
const TreeCoupleItem = React.memo(TreeCoupleItemImpl);

const TreeNodeItemImpl: React.FC<{
  prepared: PreparedNode;
  isSelected: boolean;
  isLit: boolean;
  onSelect: (person: Person, fromKeyboard: boolean) => void;
}> = ({ prepared, isSelected, isLit, onSelect }) => {
  const { node, displayName, lifespanPlace, thumbUrl, initials } = prepared;
  const p = node.person;
  let nodeStroke = '#827A6A';
  let nodeStrokeWidth = 1.1;
  if (isSelected) {
    nodeStroke = '#7A4612';
    nodeStrokeWidth = 2.4;
  } else if (node.isDirect) {
    nodeStroke = '#1B2A41';
    nodeStrokeWidth = 1.8;
  }

  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- no native button exists inside SVG; this <g> already has tabIndex, aria-label, and Enter/Space handling
    <g
      role="button"
      className={`tree-node-card${isLit ? ' is-lit' : ''}`}
      tabIndex={0}
      aria-label={`Inspect ${p.full_name}`}
      transform={`translate(${node.x}, ${node.y})`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(p, false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(p, true);
        }
      }}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={3}
        fill={isSelected ? '#1B2A41' : '#FCF9F2'}
        stroke={nodeStroke}
        strokeWidth={nodeStrokeWidth}
        strokeDasharray={node.isDirect ? undefined : '4 2'}
      />
      <circle
        cx={20}
        cy={24}
        r={12}
        fill={isSelected ? '#7A4612' : '#EAE1CE'}
        stroke={node.isDirect ? '#7A4612' : '#827A6A'}
      />
      {thumbUrl ? (
        <image
          href={thumbUrl}
          x={8}
          y={12}
          width={24}
          height={24}
          preserveAspectRatio="xMidYMid slice"
          clipPath="url(#tree-node-avatar-clip)"
        />
      ) : (
        <text
          x={20}
          y={27}
          textAnchor="middle"
          fontSize="8.8"
          fontWeight="700"
          fontFamily="IBM Plex Mono, monospace"
          fill={isSelected ? '#FCF9F2' : '#7A4612'}
        >
          {initials}
        </text>
      )}
      <text
        x={38}
        y={19}
        fontSize="10.8"
        fontWeight="700"
        fontFamily="Newsreader, Georgia, serif"
        fill={isSelected ? '#FCF9F2' : '#1B2A41'}
      >
        {displayName}
      </text>
      <text
        x={38}
        y={33}
        fontSize="8.6"
        fontFamily="IBM Plex Mono, monospace"
        fill={isSelected ? '#EAE1CE' : '#4E4A42'}
      >
        {lifespanPlace}
      </text>
    </g>
  );
};
const TreeNodeItem = React.memo(TreeNodeItemImpl);

const TreeMinimapImpl: React.FC<{
  bounds: TreeBounds;
  nodes: PlacedNode[];
  familyName: string;
  onFit: () => void;
}> = ({ bounds, nodes, familyName, onFit }) => (
  <button
    type="button"
    className="tree-minimap"
    onMouseDown={(e) => {
      e.stopPropagation();
    }}
    onClick={(e) => {
      e.stopPropagation();
      onFit();
    }}
    title={`Click minimap to recenter and fit the ${familyName} tree`}
  >
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginBottom: 4, textAlign: 'left', color: 'var(--surface-header)' }}>
      MINIMAP · CLICK TO FIT
    </div>
    <svg
      viewBox={`0 0 ${bounds.maxX} ${bounds.maxY}`}
      width="100%"
      height="68"
      style={{ background: '#F5EFE2', border: '1px solid #D6CEBE' }}
    >
      {nodes.map((n) => (
        <rect
          key={n.person.id}
          x={n.x}
          y={n.y}
          width={NODE_W}
          height={NODE_H}
          fill={n.isDirect ? '#1B2A41' : '#7A4612'}
          opacity={n.isDirect ? 0.9 : 0.55}
        />
      ))}
    </svg>
  </button>
);
const TreeMinimap = React.memo(TreeMinimapImpl);

export const TreePage: React.FC = () => {
  const { siteConfig, baseUrl, bundle, placesById, loading } = useArchiveData();
  const personThumbMap = useMemo(
    () => (bundle ? buildPersonThumbMap(bundle) : new Map<string, string>()),
    [bundle],
  );
  const [searchParams] = useSearchParams();
  const containerRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const appliedFocusSlugRef = useRef<string | null>(null);

  const transformRef = useRef<CanvasTransform>(INITIAL_TRANSFORM);
  const animationTargetRef = useRef<CanvasTransform | null>(null);
  const pendingTransformRef = useRef<CanvasTransform | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const motionRafRef = useRef<number | null>(null);
  const inertiaSpeedRef = useRef(0);
  const zoomSettleTimerRef = useRef<number | null>(null);
  const containerRectRef = useRef<{ left: number; top: number; width: number; height: number; ts: number }>({
    left: 0,
    top: 0,
    width: 1200,
    height: 760,
    ts: 0,
  });

  const activePointersRef = useRef<Map<number, Point2D>>(new Map());
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number; pointerType: string } | null>(null);
  const pinchStartRef = useRef<{
    startDist: number;
    startZoom: number;
    startPan: Point2D;
    startMidpoint: Point2D;
  } | null>(null);
  const velocitySamplesRef = useRef<{ x: number; y: number; t: number }[]>([]);
  const pinchReleaseAtRef = useRef(0);
  const lastCanvasTapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const didDragMoveRef = useRef(false);

  const defaultBranchId = useMemo(() => resolveDefaultBranchId(siteConfig), [siteConfig]);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [mode, setMode] = useState<'direct' | 'full'>('full');

  const markZooming = useCallback((): void => {
    stageRef.current?.classList.add('is-zooming');
    if (zoomSettleTimerRef.current !== null) {
      window.clearTimeout(zoomSettleTimerRef.current);
    }
    zoomSettleTimerRef.current = window.setTimeout(() => {
      zoomSettleTimerRef.current = null;
      stageRef.current?.classList.remove('is-zooming');
    }, 150);
  }, []);

  const cancelMotion = useCallback((): void => {
    if (motionRafRef.current !== null) {
      window.cancelAnimationFrame(motionRafRef.current);
      motionRafRef.current = null;
    }
    animationTargetRef.current = null;
    inertiaSpeedRef.current = 0;
  }, []);

  const writeTransformToDom = useCallback((next: CanvasTransform): void => {
    const stage = stageRef.current;
    if (stage) {
      stage.style.transform = `translate3d(${next.pan.x}px, ${next.pan.y}px, 0) scale(${next.zoom})`;
    }
    const container = containerRef.current;
    if (container) {
      container.dataset.zoom = String(next.zoom);
      container.dataset.panX = String(next.pan.x);
      container.dataset.panY = String(next.pan.y);
    }
  }, []);

  const applyTransformNow = useCallback(
    (next: CanvasTransform): void => {
      cancelMotion();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingTransformRef.current = null;
      transformRef.current = next;
      writeTransformToDom(next);
    },
    [cancelMotion, writeTransformToDom],
  );

  const scheduleTransform = useCallback(
    (next: CanvasTransform): void => {
      transformRef.current = next;
      pendingTransformRef.current = next;
      if (rafIdRef.current !== null) {
        return;
      }
      rafIdRef.current = window.requestAnimationFrame(() => {
        rafIdRef.current = null;
        const latest = pendingTransformRef.current;
        if (latest) {
          pendingTransformRef.current = null;
          writeTransformToDom(latest);
        }
      });
    },
    [writeTransformToDom],
  );

  useEffect(
    () => (): void => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (motionRafRef.current !== null) {
        window.cancelAnimationFrame(motionRafRef.current);
        motionRafRef.current = null;
      }
      if (zoomSettleTimerRef.current !== null) {
        window.clearTimeout(zoomSettleTimerRef.current);
        zoomSettleTimerRef.current = null;
      }
    },
    [],
  );

  const readContainerOffset = useCallback((forceRefresh: boolean) => {
    const now = performance.now();
    if (!forceRefresh && now - containerRectRef.current.ts < 250) {
      return containerRectRef.current;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    const next = {
      left: rect?.left ?? 0,
      top: rect?.top ?? 0,
      width: rect?.width || 1200,
      height: rect?.height || 760,
      ts: now,
    };
    containerRectRef.current = next;
    return next;
  }, []);

  const branchCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    if (!bundle) {
      return counts;
    }
    for (const p of bundle.people) {
      if (p.is_living && p.full_name === 'Living') {
        continue;
      }
      counts.all += 1;
      const b = p.branch || defaultBranchId;
      counts[b] = (counts[b] || 0) + 1;
    }
    return counts;
  }, [bundle, defaultBranchId]);

  const populatedBranches = useMemo(
    () => siteConfig.branches.filter((b) => (branchCounts[b.id] || 0) > 0),
    [siteConfig.branches, branchCounts],
  );

  const directModeBranchIds = useMemo(
    () => siteConfig.branches.filter((b) => b.supportsDirectMode).map((b) => b.id),
    [siteConfig.branches],
  );

  const activeBranchConfig = useMemo(
    () => siteConfig.branches.find((b) => b.id === branchFilter),
    [siteConfig.branches, branchFilter],
  );

  const activeBranchLabel =
    branchFilter === 'all'
      ? siteConfig.site.familyName
      : (activeBranchConfig?.label ?? branchFilter);

  const showDirectToggle =
    branchFilter === 'all' || (activeBranchConfig?.supportsDirectMode ?? true);

  const graph = useMemo(() => {
    if (!bundle) {
      return emptyTreeLayout();
    }
    return computeTreeLayout({
      people: bundle.people,
      kinship: bundle.kinship,
      branchFilter: branchFilter === 'all' ? null : branchFilter,
      defaultBranchId,
      directModeBranchIds: directModeBranchIds.length > 0 ? directModeBranchIds : undefined,
      mode,
    });
  }, [bundle, mode, branchFilter, defaultBranchId, directModeBranchIds]);

  const preparedEdges = useMemo<PreparedEdge[]>(
    () =>
      graph.edges.map((ed) => {
        const midY = (ed.fromY + ed.toY) / 2;
        return {
          key: `${ed.childId}-${ed.parentIds.join('+')}`,
          d: `M ${ed.fromX} ${ed.fromY} C ${ed.fromX} ${midY}, ${ed.toX} ${midY}, ${ed.toX} ${ed.toY}`,
          childId: ed.childId,
          parentIds: ed.parentIds,
          isDirect: ed.isDirect,
        };
      }),
    [graph.edges],
  );

  const preparedNodes = useMemo<PreparedNode[]>(
    () =>
      graph.nodes.map((node) => {
        const p = node.person;
        const pl = p.primary_place_id ? placesById.get(p.primary_place_id) : undefined;
        const rawThumb = personThumbMap.get(p.id) || p.portrait_url;
        return {
          node,
          displayName: p.full_name.length > 18 ? `${p.full_name.slice(0, 17)}…` : p.full_name,
          lifespanPlace: `${p.birth_year || '?'}–${p.death_year || '?'}${pl ? ` · ${pl.name.slice(0, 10)}` : ''}`,
          thumbUrl: rawThumb ? resolveAssetUrl(rawThumb, baseUrl) : null,
          initials: initialsOf(p.full_name),
        };
      }),
    [graph.nodes, placesById, personThumbMap, baseUrl],
  );

  const clampTransform = useCallback(
    (next: CanvasTransform): CanvasTransform => {
      const el = containerRef.current;
      const viewport = {
        width: el ? el.clientWidth : containerRectRef.current.width,
        height: el ? el.clientHeight : containerRectRef.current.height,
      };
      return {
        zoom: next.zoom,
        pan: clampPan(next.pan, next.zoom, graph.bounds, viewport),
      };
    },
    [graph.bounds],
  );

  const animateToTransform = useCallback(
    (target: CanvasTransform, durationMs = 200): void => {
      const clampedTarget = clampTransform(target);
      if (
        durationMs <= 0 ||
        (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      ) {
        applyTransformNow(clampedTarget);
        return;
      }
      cancelMotion();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingTransformRef.current = null;

      const { current: start } = transformRef;
      animationTargetRef.current = clampedTarget;
      const startTime = performance.now();
      const isScaleChanging = Math.abs(clampedTarget.zoom - start.zoom) > 0.001;
      if (isScaleChanging) {
        markZooming();
      }

      const tick = (now: number): void => {
        const progress = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - (1 - progress) ** 3;
        const frame: CanvasTransform = {
          zoom: Number((start.zoom + (clampedTarget.zoom - start.zoom) * eased).toFixed(3)),
          pan: {
            x: Number((start.pan.x + (clampedTarget.pan.x - start.pan.x) * eased).toFixed(2)),
            y: Number((start.pan.y + (clampedTarget.pan.y - start.pan.y) * eased).toFixed(2)),
          },
        };
        transformRef.current = frame;
        writeTransformToDom(frame);
        if (isScaleChanging) {
          markZooming();
        }
        if (progress < 1) {
          motionRafRef.current = window.requestAnimationFrame(tick);
        } else {
          motionRafRef.current = null;
          animationTargetRef.current = null;
          transformRef.current = clampedTarget;
          writeTransformToDom(clampedTarget);
        }
      };
      motionRafRef.current = window.requestAnimationFrame(tick);
    },
    [applyTransformNow, cancelMotion, clampTransform, markZooming, writeTransformToDom],
  );

  const startInertia = useCallback(
    (initialVx: number, initialVy: number): void => {
      cancelMotion();
      let vx = initialVx;
      let vy = initialVy;
      let lastTime = performance.now();
      inertiaSpeedRef.current = Math.hypot(vx, vy);

      const tick = (now: number): void => {
        const dt = now - lastTime;
        lastTime = now;
        const { current } = transformRef;
        const { next, done } = stepInertia({ pan: current.pan, vx, vy }, dt);
        const clamped = clampTransform({ zoom: current.zoom, pan: next.pan });

        vx = Math.abs(clamped.pan.x - next.pan.x) > 0.5 ? 0 : next.vx;
        vy = Math.abs(clamped.pan.y - next.pan.y) > 0.5 ? 0 : next.vy;
        const speed = Math.hypot(vx, vy);
        inertiaSpeedRef.current = speed;

        transformRef.current = clamped;
        writeTransformToDom(clamped);

        if (done || speed < 0.025) {
          motionRafRef.current = null;
          inertiaSpeedRef.current = 0;
        } else {
          motionRafRef.current = window.requestAnimationFrame(tick);
        }
      };
      motionRafRef.current = window.requestAnimationFrame(tick);
    },
    [cancelMotion, clampTransform, writeTransformToDom],
  );

  const computeFitTransform = useCallback((): CanvasTransform => {
    const el = containerRef.current;
    const vw = el ? el.clientWidth : 1200;
    const vh = el ? el.clientHeight : 760;
    const gw = Math.max(400, graph.bounds.maxX - graph.bounds.minX);
    const gh = Math.max(400, graph.bounds.maxY - graph.bounds.minY);
    const padX = vw < 640 ? 24 : 60;
    const padY = vw < 640 ? 96 : 60;
    const nextZoom = Math.max(0.24, Math.min(1, Math.min((vw - padX) / gw, (vh - padY) / gh)));
    const nextX = (vw - gw * nextZoom) / 2;
    const nextY = Math.max(vw < 640 ? 56 : 16, (vh - gh * nextZoom) / 2);
    return {
      zoom: Number(nextZoom.toFixed(2)),
      pan: { x: Math.round(nextX), y: Math.round(nextY) },
    };
  }, [graph.bounds.maxX, graph.bounds.minX, graph.bounds.maxY, graph.bounds.minY]);

  const fitToViewport = useCallback(() => {
    applyTransformNow(computeFitTransform());
  }, [applyTransformNow, computeFitTransform]);

  const animateFitToViewport = useCallback(() => {
    animateToTransform(computeFitTransform(), 210);
  }, [animateToTransform, computeFitTransform]);

  useLayoutEffect(() => {
    if (graph.nodes.length === 0) {
      return;
    }
    const focusSlug = searchParams.get('focus');
    if (focusSlug && appliedFocusSlugRef.current !== focusSlug) {
      const targetNode = graph.nodes.find((n) => n.person.slug === focusSlug);
      if (targetNode) {
        appliedFocusSlugRef.current = focusSlug;
        setSelectedPerson(targetNode.person);
        const el = containerRef.current;
        const vw = el ? el.clientWidth : 1200;
        const vh = el ? el.clientHeight : 760;
        const nextZoom = 0.85;
        const cx = targetNode.x + NODE_W / 2;
        const cy = targetNode.y + NODE_H / 2;
        applyTransformNow({
          zoom: nextZoom,
          pan: {
            x: Math.round(vw / 2 - cx * nextZoom),
            y: Math.round(vh / 2 - cy * nextZoom),
          },
        });
        return;
      }
    }
    fitToViewport();
  }, [fitToViewport, searchParams, graph.nodes, applyTransformNow]);

  const isReady = !loading && Boolean(bundle);

  useEffect(() => {
    const el = containerRef.current;
    if (!isReady || !el) {
      return undefined;
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      cancelMotion();
      const offset = readContainerOffset(false);
      const focalPoint = { x: e.clientX - offset.left, y: e.clientY - offset.top };
      const { current } = transformRef;
      const targetZoom = computeWheelTargetZoom(current.zoom, e.deltaY, e.ctrlKey);
      const next = clampTransform(
        computeZoomAroundPoint({
          currentPan: current.pan,
          currentZoom: current.zoom,
          targetZoom,
          focalPoint,
        }),
      );
      markZooming();
      scheduleTransform(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return (): void => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [isReady, cancelMotion, clampTransform, markZooming, readContainerOffset, scheduleTransform]);

  const setDraggingClass = useCallback((active: boolean): void => {
    containerRef.current?.classList.toggle('is-dragging', active);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('tree-viewport-lock');
    return (): void => {
      document.documentElement.classList.remove('tree-viewport-lock');
    };
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>): void => {
      if (e.target instanceof Element && e.target.closest('button, a, .tree-toolbar, .tree-popover, .tree-controls, .tree-minimap')) {
        return;
      }
      const wasFastCoasting = inertiaSpeedRef.current > 0.15;
      cancelMotion();

      const offset = readContainerOffset(true);
      const localPt = {
        x: e.clientX - offset.left,
        y: e.clientY - offset.top,
      };
      activePointersRef.current.set(e.pointerId, localPt);

      const { current } = transformRef;
      if (activePointersRef.current.size === 1) {
        didDragMoveRef.current = wasFastCoasting;
        velocitySamplesRef.current = [{ x: localPt.x, y: localPt.y, t: performance.now() }];
        setDraggingClass(true);
        dragStartRef.current = {
          x: localPt.x,
          y: localPt.y,
          panX: current.pan.x,
          panY: current.pan.y,
          pointerType: e.pointerType,
        };
        pinchStartRef.current = null;
      } else if (activePointersRef.current.size === 2) {
        didDragMoveRef.current = true;
        lastCanvasTapRef.current = null;
        velocitySamplesRef.current = [];
        const [p1, p2] = [...activePointersRef.current.values()];
        setDraggingClass(false);
        dragStartRef.current = null;
        pinchStartRef.current = {
          startDist: distanceBetween(p1, p2),
          startZoom: current.zoom,
          startPan: { ...current.pan },
          startMidpoint: midpointBetween(p1, p2),
        };
        markZooming();
      }
    },
    [cancelMotion, markZooming, readContainerOffset, setDraggingClass],
  );

  const handlePointerMoveNative = useCallback(
    (e: PointerEvent): void => {
      if (!activePointersRef.current.has(e.pointerId)) {
        return;
      }
      const offset = containerRectRef.current;
      const localPt = {
        x: e.clientX - offset.left,
        y: e.clientY - offset.top,
      };
      activePointersRef.current.set(e.pointerId, localPt);

      if (activePointersRef.current.size === 2 && pinchStartRef.current) {
        const [p1, p2] = [...activePointersRef.current.values()];
        didDragMoveRef.current = true;
        const next = clampTransform(
          computePinchTransform({
            startDist: pinchStartRef.current.startDist,
            currentDist: distanceBetween(p1, p2),
            startZoom: pinchStartRef.current.startZoom,
            startPan: pinchStartRef.current.startPan,
            startMidpoint: pinchStartRef.current.startMidpoint,
            currentMidpoint: midpointBetween(p1, p2),
          }),
        );
        markZooming();
        scheduleTransform(next);
      } else if (activePointersRef.current.size === 1 && dragStartRef.current) {
        const now = performance.now();
        if (now - pinchReleaseAtRef.current < 80) {
          const { current } = transformRef;
          dragStartRef.current = {
            ...dragStartRef.current,
            x: localPt.x,
            y: localPt.y,
            panX: current.pan.x,
            panY: current.pan.y,
          };
          return;
        }

        const dx = localPt.x - dragStartRef.current.x;
        const dy = localPt.y - dragStartRef.current.y;
        const threshold = dragStartRef.current.pointerType === 'touch' ? 8 : 6;
        if (!didDragMoveRef.current && isDragMovement(dx, dy, threshold)) {
          didDragMoveRef.current = true;
        }

        const samples = velocitySamplesRef.current;
        samples.push({ x: localPt.x, y: localPt.y, t: now });
        while (samples.length > 8 || (samples.length > 2 && now - samples[0].t > 95)) {
          samples.shift();
        }

        const next = clampTransform({
          zoom: transformRef.current.zoom,
          pan: {
            x: Number((dragStartRef.current.panX + dx).toFixed(2)),
            y: Number((dragStartRef.current.panY + dy).toFixed(2)),
          },
        });
        scheduleTransform(next);
      }
    },
    [clampTransform, markZooming, scheduleTransform],
  );

  const handlePointerUpNative = useCallback(
    (e: PointerEvent): void => {
      if (!activePointersRef.current.has(e.pointerId)) {
        return;
      }
      const wasPinch = activePointersRef.current.size >= 2;
      const releasePt = activePointersRef.current.get(e.pointerId);
      const isCancel = e.type === 'pointercancel';
      activePointersRef.current.delete(e.pointerId);

      if (activePointersRef.current.size < 2) {
        pinchStartRef.current = null;
      }
      if (activePointersRef.current.size === 1) {
        if (wasPinch) {
          pinchReleaseAtRef.current = performance.now();
        }
        const [remaining] = [...activePointersRef.current.values()];
        const { current } = transformRef;
        velocitySamplesRef.current = [{ x: remaining.x, y: remaining.y, t: performance.now() }];
        dragStartRef.current = {
          x: remaining.x,
          y: remaining.y,
          panX: current.pan.x,
          panY: current.pan.y,
          pointerType: e.pointerType,
        };
        setDraggingClass(true);
      } else {
        const moved = didDragMoveRef.current;
        const samples = velocitySamplesRef.current;
        const now = performance.now();
        dragStartRef.current = null;
        velocitySamplesRef.current = [];
        setDraggingClass(false);

        if (!isCancel && moved && now - pinchReleaseAtRef.current > 140 && samples.length >= 2) {
          const newest = samples.at(-1);
          const [oldest] = samples;
          const dt = newest ? newest.t - oldest.t : 0;
          if (newest && now - newest.t < 65 && dt >= 8) {
            const rawVx = (newest.x - oldest.x) / dt;
            const rawVy = (newest.y - oldest.y) / dt;
            const speed = Math.hypot(rawVx, rawVy);
            if (speed > 0.12) {
              const maxSpeed = 2.6;
              const scale = speed > maxSpeed ? maxSpeed / speed : 1;
              startInertia(rawVx * scale, rawVy * scale);
            }
          }
        } else if (!isCancel && !moved && e.pointerType === 'touch' && releasePt) {
          const isOnNode = e.target instanceof Element && Boolean(e.target.closest('.tree-node-card'));
          const prevTap = lastCanvasTapRef.current;
          if (!isOnNode && prevTap && now - prevTap.t < 300 && distanceBetween(prevTap, releasePt) < 34) {
            lastCanvasTapRef.current = null;
            didDragMoveRef.current = true;
            const { current } = transformRef;
            const fit = computeFitTransform();
            const targetZoom = computeDoubleTapZoom(current.zoom, fit.zoom);
            if (Math.abs(targetZoom - fit.zoom) < 0.01) {
              animateToTransform(fit, 210);
            } else {
              animateToTransform(
                computeZoomAroundPoint({
                  currentPan: current.pan,
                  currentZoom: current.zoom,
                  targetZoom,
                  focalPoint: releasePt,
                }),
                210,
              );
            }
          } else if (isOnNode) {
            lastCanvasTapRef.current = null;
          } else {
            lastCanvasTapRef.current = { x: releasePt.x, y: releasePt.y, t: now };
          }
        }

        window.setTimeout(() => {
          didDragMoveRef.current = false;
        }, 0);
      }
    },
    [animateToTransform, computeFitTransform, setDraggingClass, startInertia],
  );

  useEffect(() => {
    const onWindowBlur = (): void => {
      activePointersRef.current.clear();
      dragStartRef.current = null;
      pinchStartRef.current = null;
      velocitySamplesRef.current = [];
      setDraggingClass(false);
    };
    window.addEventListener('pointermove', handlePointerMoveNative);
    window.addEventListener('pointerup', handlePointerUpNative);
    window.addEventListener('pointercancel', handlePointerUpNative);
    window.addEventListener('blur', onWindowBlur);
    return (): void => {
      window.removeEventListener('pointermove', handlePointerMoveNative);
      window.removeEventListener('pointerup', handlePointerUpNative);
      window.removeEventListener('pointercancel', handlePointerUpNative);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [handlePointerMoveNative, handlePointerUpNative, setDraggingClass]);

  const handleSelectPerson = useCallback((person: Person, fromKeyboard: boolean): void => {
    if (!fromKeyboard && didDragMoveRef.current) {
      return;
    }
    setSelectedPerson(person);
  }, []);

  const highlightedIds = useMemo(() => {
    if (!selectedPerson) {
      return null;
    }
    const set = new Set<string>([selectedPerson.id]);
    const walkUp = (id: string): void => {
      for (const pid of graph.parentMap.get(id) || []) {
        if (!set.has(pid)) {
          set.add(pid);
          walkUp(pid);
        }
      }
    };
    const walkDown = (id: string): void => {
      for (const cid of graph.childMap.get(id) || []) {
        if (!set.has(cid)) {
          set.add(cid);
          walkDown(cid);
        }
      }
    };
    walkUp(selectedPerson.id);
    walkDown(selectedPerson.id);
    return set;
  }, [selectedPerson, graph.parentMap, graph.childMap]);

  const stageStyle = useMemo(
    () => ({
      width: graph.bounds.maxX,
      height: graph.bounds.maxY,
    }),
    [graph.bounds.maxX, graph.bounds.maxY],
  );

  if (loading || !bundle) {
    return (
      <div>
        <ExplorerTopBar />
        <main className="index-page">Loading 2D spatial-temporal canvas…</main>
      </div>
    );
  }

  const hasSelection = highlightedIds !== null;
  const activeCount = branchCounts[branchFilter] ?? graph.nodes.length;

  return (
    <div>
      <ExplorerTopBar />
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- pan/zoom canvas */}
      <main
        ref={containerRef}
        className="tree-page"
        onPointerDown={handlePointerDown}
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest('button, a, .tree-toolbar, .tree-popover, .tree-controls, .tree-minimap')) {
            return;
          }
          if (!didDragMoveRef.current) {
            setSelectedPerson(null);
          }
        }}
      >
        <div className="tree-toolbar">
          {populatedBranches.length > 1 && (
            <select
              className="pill-btn tree-branch-select"
              aria-label="Select family branch for 2D Tree"
              value={branchFilter}
              onChange={(e) => {
                setBranchFilter(e.target.value);
                setSelectedPerson(null);
              }}
            >
              <option value="all">All Branches ({branchCounts.all || 0})</option>
              {populatedBranches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} ({branchCounts[b.id] || 0})
                </option>
              ))}
            </select>
          )}
          {showDirectToggle && (
            <>
              <button
                type="button"
                className={`pill-btn ${mode === 'full' ? 'active' : ''}`}
                onClick={() => {
                  setMode('full');
                }}
              >
                Full Tree ({activeCount})
              </button>
              <button
                type="button"
                className={`pill-btn ${mode === 'direct' ? 'active' : ''}`}
                onClick={() => {
                  setMode('direct');
                }}
              >
                Direct Spine
              </button>
            </>
          )}
        </div>

        <div ref={stageRef} className="tree-stage" style={stageStyle}>
          <svg
            className={`tree-canvas${hasSelection ? ' has-selection' : ''}`}
            width={graph.bounds.maxX}
            height={graph.bounds.maxY}
            viewBox={`0 0 ${graph.bounds.maxX} ${graph.bounds.maxY}`}
            role="img"
            aria-label={`Hierarchical 2D ${activeBranchLabel} family tree canvas`}
          >
            <defs>
              <clipPath id="tree-node-avatar-clip">
                <circle cx="20" cy="24" r="12" />
              </clipPath>
            </defs>

            <TreeGenBands genBands={graph.genBands} maxX={graph.bounds.maxX} />

            <g>
              {preparedEdges.map((ed) => {
                const isLit = Boolean(
                  highlightedIds &&
                    highlightedIds.has(ed.childId) &&
                    ed.parentIds.some((pid) => highlightedIds.has(pid)),
                );
                return (
                  <TreeEdgeItem
                    key={ed.key}
                    d={ed.d}
                    isDirect={ed.isDirect}
                    isLit={isLit}
                  />
                );
              })}
            </g>

            <g>
              {graph.couples.map((c) => {
                const isLit = Boolean(
                  highlightedIds &&
                    (highlightedIds.has(c.a.person.id) || highlightedIds.has(c.b.person.id)),
                );
                return (
                  <TreeCoupleItem
                    key={`${c.a.person.id}-${c.b.person.id}`}
                    couple={c}
                    isLit={isLit}
                  />
                );
              })}
            </g>

            <g>
              {preparedNodes.map((prepared) => {
                const pid = prepared.node.person.id;
                const isSelected = selectedPerson?.id === pid;
                const isLit = Boolean(highlightedIds?.has(pid));
                return (
                  <TreeNodeItem
                    key={pid}
                    prepared={prepared}
                    isSelected={isSelected}
                    isLit={isLit}
                    onSelect={handleSelectPerson}
                  />
                );
              })}
            </g>
          </svg>
        </div>

        {selectedPerson && (
          <div className="tree-popover">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--radar-copresence)' }}>
                {selectedPerson.lineage_group.toUpperCase()}
              </span>
              <button
                type="button"
                className="pill-btn"
                style={{ padding: '2px 7px', fontSize: '0.78rem' }}
                onClick={() => {
                  setSelectedPerson(null);
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
              {(personThumbMap.get(selectedPerson.id) || selectedPerson.portrait_url) && (
                <img
                  src={resolveAssetUrl(
                    personThumbMap.get(selectedPerson.id) || selectedPerson.portrait_url || '',
                    baseUrl,
                  )}
                  alt={selectedPerson.full_name}
                  style={{ width: 46, height: 56, objectFit: 'cover', borderRadius: 2, border: '1px solid var(--border-control)', flexShrink: 0 }}
                />
              )}
              <div>
                <h2 style={{ fontFamily: 'var(--font-serif)', margin: '0 0 2px', color: 'var(--surface-header)', fontSize: '1.18rem' }}>
                  {selectedPerson.full_name}
                </h2>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--radar-copresence)' }}>
                  {selectedPerson.birth_edtf || '?'} — {selectedPerson.death_edtf || '?'}
                </div>
              </div>
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 10 }}>
              Primary place:{' '}
              {selectedPerson.primary_place_id
                ? placesById.get(selectedPerson.primary_place_id)?.full_name
                : 'Unrecorded'}
              {(selectedPerson.media_count || 0) > 0 && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.74rem', marginTop: 4, color: 'var(--surface-header)' }}>
                  {selectedPerson.media_count} archival {selectedPerson.media_count === 1 ? 'photo/scan' : 'photos & scans'} attached
                </div>
              )}
            </div>
            <Link
              to={`/person/${selectedPerson.slug}`}
              className="pill-btn active"
              style={{ display: 'inline-block', textDecoration: 'none' }}
            >
              Open Timeline →
            </Link>
          </div>
        )}

        <TreeMinimap
          bounds={graph.bounds}
          nodes={graph.nodes}
          familyName={siteConfig.site.familyName}
          onFit={animateFitToViewport}
        />

        <div className="tree-controls">
          <button
            type="button"
            className="pill-btn"
            aria-label="Zoom in"
            onClick={() => {
              const el = containerRef.current;
              const focal = { x: (el?.clientWidth ?? 800) / 2, y: (el?.clientHeight ?? 600) / 2 };
              const base = animationTargetRef.current ?? transformRef.current;
              const next = computeZoomAroundPoint({
                currentPan: base.pan,
                currentZoom: base.zoom,
                targetZoom: base.zoom * 1.28,
                focalPoint: focal,
              });
              animateToTransform(next, 180);
            }}
          >
            +
          </button>
          <button
            type="button"
            className="pill-btn"
            aria-label="Zoom out"
            onClick={() => {
              const el = containerRef.current;
              const focal = { x: (el?.clientWidth ?? 800) / 2, y: (el?.clientHeight ?? 600) / 2 };
              const base = animationTargetRef.current ?? transformRef.current;
              const next = computeZoomAroundPoint({
                currentPan: base.pan,
                currentZoom: base.zoom,
                targetZoom: base.zoom / 1.28,
                focalPoint: focal,
              });
              animateToTransform(next, 180);
            }}
          >
            −
          </button>
          <button type="button" className="pill-btn" onClick={animateFitToViewport}>
            Fit
          </button>
        </div>
      </main>
    </div>
  );
};
